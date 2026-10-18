import { randomUUID } from "node:crypto"
import { createRetryingClient, resolveRetryPolicy, mapModelRequest, observeModelClient, type LLMUsage, type ModelClient } from "@i-harness/llm-seam"
import type { buildModelClient } from "@i-harness/provider"
import { validateRequestMetrics, type UsageRecord } from "@i-harness/usage-stats"

/** Captures provider attempts, below retries and above protocol adapters. The
 * only durable data is the explicit UsageRecord allowlist. */
export function createUsageCapture(options: {
  workspace: string
  record: (record: UsageRecord) => Promise<void>
  onRequestFacts?: (record: Pick<UsageRecord, "id" | "projectId" | "sessionId" | "providerId" | "modelId" | "requestMetrics" | "status">) => void
  projectFor?: (sessionId: string) => Promise<string | undefined>
  onWarning?: (warnings: string[]) => void
  now?: () => number
}) {
  const now = options.now ?? Date.now
  let failedWrites = 0
  let failedAttributions = 0
  let invalidMeasurements = 0
  const warnings = () => [
      ...(failedWrites ? [`Usage recording failed for ${failedWrites} request(s); statistics may be incomplete.`] : []),
      ...(failedAttributions ? [`Project attribution failed for ${failedAttributions} request(s); project statistics may be incomplete.`] : []),
      ...(invalidMeasurements ? [`Invalid provider usage was omitted for ${invalidMeasurements} request(s); token statistics may be incomplete.`] : []),
    ]
  const notifyWarning = () => { try { options.onWarning?.(warnings()) } catch { /* Diagnostics cannot fail inference. */ } }
  return {
    warnings,
    bind(client: ModelClient, sessionId: string): ModelClient {
      return mapModelRequest(client, request => ({ ...request, sessionId: request.sessionId ?? sessionId }))
    },
    buildClient(build: typeof buildModelClient): typeof buildModelClient {
      return (profile, model, extra) => {
        // Attribution belongs to the same resolved profile that built the
        // protocol client, even if a caller later replaces its profile fields.
        profile = { ...profile }
        // The provider builder ordinarily installs retries. Move that one layer
        // outside capture so usage from failed attempts is not discarded by it.
        const client = build({ ...profile, retryPolicy: undefined }, model, extra)
        const capture = observeModelClient(mapModelRequest(client, request => {
          const { sessionId: _sessionId, ...providerRequest } = request
          return providerRequest
        }), {
          async start(request, measurement) {
            request.signal?.throwIfAborted()
            let projectId: string | undefined
            if (request.sessionId && options.projectFor) {
              try { projectId = await options.projectFor(request.sessionId) } catch { failedAttributions++; notifyWarning() }
            }
            request.signal?.throwIfAborted()
            return { request, measurement, projectId, startedAt: now(), id: randomUUID(), firstTokenMs: undefined as number | undefined, usage: {} as LLMUsage }
          },
          event(state, event) {
            const usage = state.usage
            if (event.type === "usage") {
              for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
                const value = event.usage[key]
                if (value !== undefined && Number.isSafeInteger(value) && value >= 0) usage[key] = value
              }
              if (event.usage.inputTokenSemantics === "includes-cache" || event.usage.inputTokenSemantics === "excludes-cache") usage.inputTokenSemantics = event.usage.inputTokenSemantics
              if (profile.protocol === "openai-responses" && usage.inputTokens !== undefined && usage.cacheCreationTokens === undefined) usage.cacheCreationTokens = 0
            }
            if (state.firstTokenMs === undefined && ((event.type === "text/chunk" || event.type === "reasoning") && event.text.length > 0 || event.type === "tool_call")) state.firstTokenMs = Math.max(0, now() - state.startedAt)
          },
          async finish(state, status) {
            const { request, measurement, projectId, startedAt, id, firstTokenMs, usage } = state
            const contradictory = usage.inputTokenSemantics === "includes-cache" && usage.inputTokens !== undefined
              && (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0) > usage.inputTokens
            if (contradictory) { invalidMeasurements++; notifyWarning() }
            const record: UsageRecord = {
              id, startedAt, durationMs: Math.max(0, now() - startedAt),
              ...(firstTokenMs === undefined ? {} : { firstTokenMs }), workspace: options.workspace,
              ...(projectId === undefined ? {} : { projectId }),
              ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
              providerId: profile.name, modelId: model ?? profile.defaultModel ?? "unknown",
              billing: profile.codexSubscription ? "subscription" : "api", status, ...(contradictory ? {} : usage),
            }
            try {
              const { input, packet, output } = measurement
              record.requestMetrics = validateRequestMetrics({ version: 1, coverage: input.coverage, ...packet,
                systemTokens: input.components.system.heuristicTokens, schemaTokens: input.components.toolSchemas.heuristicTokens,
                reasoningTokens: input.components.replayedReasoning.heuristicTokens, imageCount: input.components.images.imageCount,
                capSupport: output.capSupport, configuredOutputCap: output.configuredCap, effectiveOutputCap: output.effectiveCap,
                minimumOutputCap: output.minimumCap, reasoningBudget: output.reasoningBudget })
            } catch { /* Optional diagnostics cannot fail inference or billing capture. */ }
            try { options.onRequestFacts?.({ id: record.id, projectId: record.projectId, sessionId: record.sessionId, providerId: record.providerId, modelId: record.modelId, requestMetrics: record.requestMetrics, status: record.status }) } catch { /* Observer isolation. */ }
            try { await options.record(record) } catch { failedWrites++; notifyWarning() }
          },
        })
        return profile.retryPolicy === undefined ? capture : createRetryingClient(capture, resolveRetryPolicy(profile.retryPolicy), { providerId: profile.name, modelId: model ?? profile.defaultModel })
      }
    },
  }
}
