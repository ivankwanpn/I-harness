import { randomUUID } from "node:crypto"
import { createRetryingClient, resolveRetryPolicy, type LLMUsage, type ModelClient } from "@i-harness/llm-seam"
import type { buildModelClient } from "@i-harness/provider"
import type { UsageRecord } from "@i-harness/usage-stats"

/** Captures provider attempts, below retries and above protocol adapters. The
 * only durable data is the explicit UsageRecord allowlist. */
export function createUsageCapture(options: {
  workspace: string
  record: (record: UsageRecord) => Promise<void>
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
      return { stream: request => client.stream({ ...request, sessionId: request.sessionId ?? sessionId }) }
    },
    buildClient(build: typeof buildModelClient): typeof buildModelClient {
      return (profile, model, extra) => {
        // The provider builder ordinarily installs retries. Move that one layer
        // outside capture so usage from failed attempts is not discarded by it.
        const client = build({ ...profile, retryPolicy: undefined }, model, extra)
        const capture: ModelClient = {
          async *stream(request) {
            request.signal?.throwIfAborted()
            const { sessionId, ...providerRequest } = request
            let projectId: string | undefined
            if (sessionId && options.projectFor) {
              try { projectId = await options.projectFor(sessionId) } catch { failedAttributions++; notifyWarning() }
            }
            request.signal?.throwIfAborted()
            const startedAt = now()
            const id = randomUUID()
            let firstTokenMs: number | undefined
            let status: UsageRecord["status"] = "cancelled"
            const usage: LLMUsage = {}
            try {
              for await (const event of client.stream(providerRequest)) {
                if (event.type === "usage") {
                  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
                    const value = event.usage[key]
                    if (value !== undefined && Number.isSafeInteger(value) && value >= 0) usage[key] = value
                  }
                  if (event.usage.inputTokenSemantics === "includes-cache" || event.usage.inputTokenSemantics === "excludes-cache") usage.inputTokenSemantics = event.usage.inputTokenSemantics
                  // Responses has no separately billed cache-creation bucket.
                  // Do not fabricate read counts when a provider omits them.
                  if (profile.protocol === "openai-responses" && usage.inputTokens !== undefined && usage.cacheCreationTokens === undefined) usage.cacheCreationTokens = 0
                }
                if (firstTokenMs === undefined && ((event.type === "text/chunk" || event.type === "reasoning") && event.text.length > 0 || event.type === "tool_call")) firstTokenMs = Math.max(0, now() - startedAt)
                if (event.type === "error") status = request.signal?.aborted ? "cancelled" : "failed"
                if (event.type === "end" && status !== "failed") status = "completed"
                yield event
              }
              if (status !== "failed") status = request.signal?.aborted ? "cancelled" : "completed"
            } catch (error) {
              status = request.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failed"
              throw error
            } finally {
              const contradictory = usage.inputTokenSemantics === "includes-cache" && usage.inputTokens !== undefined
                && (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0) > usage.inputTokens
              if (contradictory) { invalidMeasurements++; notifyWarning() }
              const record: UsageRecord = {
                id, startedAt, durationMs: Math.max(0, now() - startedAt),
                ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
                workspace: options.workspace,
                ...(projectId === undefined ? {} : { projectId }),
                ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
                providerId: profile.name, modelId: model ?? profile.defaultModel ?? "unknown",
                billing: profile.codexSubscription ? "subscription" : "api", status, ...(contradictory ? {} : usage),
              }
              // Waiting ensures host drain includes writes. A write failure must
              // never reach retries and repeat an already billed model request.
              try { await options.record(record) } catch { failedWrites++; notifyWarning() }
            }
          },
        }
        return profile.retryPolicy === undefined ? capture : createRetryingClient(capture, resolveRetryPolicy(profile.retryPolicy))
      }
    },
  }
}
