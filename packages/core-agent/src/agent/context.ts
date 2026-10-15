import { createExecutionOwner } from "./execution.ts"
import { createCompactionEngine, resolveCompactSpec, type CompactionConfig } from "@i-harness/compaction"
import { deriveProjectionRewrite, type ContextBindingMetadata } from "@i-harness/core-session"
import { mapModelRequest } from "@i-harness/llm-seam"
import type { AgentBudgetConfig, AgentDeps, AgentConfig, Agent, ModelContextBindingDescriptor } from "./types.ts"
import { createOwnedBudget } from "./budget.ts"
import { captureRequestCandidate } from "./request-snapshot.ts"
import { projectionFingerprint } from "@i-harness/token-meter"
import { snapshotModelData } from "@i-harness/llm-seam"

const scalarIdentity = (binding: ModelContextBindingDescriptor) => projectionFingerprint({ contextMetadata: binding.contextMetadata, budgetBinding: binding.budgetBinding, contextWindow: binding.contextWindow, maxOutputTokens: binding.maxOutputTokens, reasoningEffort: binding.reasoningEffort })
function inheritedBindingCurrent(current: ModelContextBindingDescriptor | undefined, inherited: ModelContextBindingDescriptor | undefined, scalars: string | undefined): boolean {
  return !current || !!inherited && current.identity === inherited.identity && scalarIdentity(current) === scalars
}

function validateBudget(budget: AgentBudgetConfig | undefined): void {
  if (budget !== undefined) {
    const { contextWindow, resetRetainLast, overheadTokens, reserveRatio } = budget
    if (!(Number.isSafeInteger(contextWindow) && contextWindow > 0)) {
      throw new Error(`budget.contextWindow must be a finite positive number (got ${contextWindow})`)
    }
    if (reserveRatio !== undefined && !(reserveRatio > 0 && reserveRatio <= 1)) throw new Error(`reserveRatio must be in (0, 1] (got ${reserveRatio})`)
    if (resetRetainLast !== undefined && (!Number.isInteger(resetRetainLast) || resetRetainLast < 0)) {
      throw new Error(`budget.resetRetainLast must be a non-negative integer (got ${resetRetainLast})`)
    }
    // M33 §3.1: fail loud at creation like resetRetainLast — a NaN/negative
    // overhead would silently poison every comparison downstream.
    if (overheadTokens !== undefined && (!Number.isInteger(overheadTokens) || overheadTokens < 0)) {
      throw new Error(`budget.overheadTokens must be a non-negative integer (got ${overheadTokens})`)
    }
  }
}

export function createAgentContext(deps: AgentDeps & AgentConfig, requestSessionId: string) {
  const execution = createExecutionOwner()
  validateBudget(deps.budget)
  const projectionRevision = (): number => deriveProjectionRewrite(deps.session).markers
    + deps.session.events.filter(event => event.type === "compaction/prune").length
  let inherited = deps.bindingForStep?.()
  let inheritedScalars = inherited && scalarIdentity(inherited)
  if (inherited) inherited = { ...inherited, contextMetadata: snapshotModelData(inherited.contextMetadata), budgetBinding: snapshotModelData(inherited.budgetBinding) }
  let hasMetadataOverride = false
  let metadataOverride: ContextBindingMetadata | undefined
  let hasBudgetBindingOverride = false
  let budgetBindingOverride: import("@i-harness/llm-seam").ModelBudgetBinding | undefined
  const metadata = () => inherited ? inherited.contextMetadata : hasMetadataOverride ? metadataOverride : typeof deps.contextMetadata === "function" ? deps.contextMetadata() : deps.contextMetadata
  const budgetBinding = () => inherited ? inherited.budgetBinding : hasBudgetBindingOverride ? budgetBindingOverride : typeof deps.budgetBinding === "function" ? deps.budgetBinding() : deps.budgetBinding
  const reasoningEffort = () => inherited ? inherited.reasoningEffort : deps.reasoningEffort
  // Pure live request surface, shared by admission and scalar freshness. History
  // has its own accepted fingerprint so output does not require a shadow prepare.
  const requestSurfaceFingerprint = () => projectionFingerprint({ system: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
    tools: deps.modelToolSchemas?.() ?? deps.tools.schemas(), effort: reasoningEffort(), binding: metadata(), budgetBinding: budgetBinding(), rewrite: projectionRevision() })
  const captureCandidate = () => {
    const selected = { model: deps.model, bindingIdentity: deps.modelBindingIdentity?.(), executionIdentity: inherited?.executionIdentity ?? deps.executionIdentity?.() ?? deps.model.executionIdentity }
    const binding = metadata()
    return captureRequestCandidate(deps.session, requestSessionId, selected, {
      systemPrompt: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
      tools: deps.modelToolSchemas?.() ?? deps.tools.schemas(), reasoningEffort: reasoningEffort(),
      maxOutputTokens: inherited ? inherited.maxOutputTokens : updated ? outputCap : deps.maxOutputTokens,
      contextWindow: inherited ? inherited.contextWindow : binding ? binding.contextWindow : budgetCfg?.contextWindow ?? deps.compact?.contextWindow,
      binding, budgetBinding: budgetBinding(),
    }, projectionRevision())
  }
  const ownedBudget = createOwnedBudget(deps.session, requestSessionId, captureCandidate, execution.observationLifetimeId, execution.expected)
  const contextMeter = { invalidate: () => ownedBudget.invalidateCalibration() }
  // M11: optional compaction seam. No `compact` config → no engine → the agent
  // behaves byte-identically to before this milestone.
  // M5/D2: the agent is the only layer that knows the shape the model sees, so
  // it hands the engine a getter — read at compact time, matching the LAST
  // request rather than whatever was true at construction. Without this the
  // summarizer falls back to its text form and the whole conversation is re-read
  // at full price; with it, the call is a byte-prefix of the main request and the
  // provider's cache serves it.
  function buildCompactor(compact: CompactionConfig | undefined, cap: number | undefined, binding = metadata(), budget = budgetBinding()) {
    if (!compact) return undefined
    const attributedModel = deps.sessionId === undefined ? deps.model : mapModelRequest(deps.model, request => ({ ...request, sessionId: request.sessionId ?? deps.sessionId }))
    return createCompactionEngine({
        model: attributedModel,
        config: compact.summarizationModel === deps.model ? { ...compact, summarizationModel: attributedModel } : compact,
        ...(deps.telemetry ? { telemetry: { close() {}, emit(event) { deps.telemetry!.emit({ ...event, data: { ...event.data, sessionId: deps.sessionId } }) } } } : {}),
        // The main binding's output limit bounds only inherited summaries.
        // Preferred summary output, retention, metadata and effort have their
        // own producer/consumer contract at this factory boundary.
        ...(cap !== undefined ? { maxOutputTokens: cap } : {}),
        contextMetadata: binding,
        budgetBinding: budget,
        reasoningEffort: reasoningEffort(),
        signal: deps.signal,
        flush: deps.flush,
        summaryInputGuard: inheritSummary => {
          const model = deps.model, identity = deps.modelBindingIdentity?.(), surface = requestSurfaceFingerprint()
          return () => {
            if (inheritSummary && (deps.model !== model || deps.modelBindingIdentity?.() !== identity || !bindingIsCurrent() || requestSurfaceFingerprint() !== surface)) {
              throw Object.assign(new Error("Owned summary binding or request surface changed"), { code: "CONTEXT_INPUT_STALE" })
            }
          }
        },
        ...(deps.modelOverheadTokens ? { overheadTokens: deps.modelOverheadTokens } : {}),
        contextTokens: () => ownedBudget.pressure() ?? 0,
        ...(binding?.providerId ? { provider: binding.providerId } : {}),
        ...(binding?.modelId ? { modelId: binding.modelId } : {}),
        requestShape: () => ({
          systemPrompt: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
          tools: deps.modelToolSchemas?.() ?? deps.tools.schemas(),
        }),
      })
  }
  const inheritedCompact = () => inherited?.contextWindow === undefined ? undefined : { ...(deps.compact ?? {}), contextWindow: inherited.contextWindow }
  let compactor = buildCompactor(inherited ? inheritedCompact() : deps.compact, inherited ? inherited.maxOutputTokens : deps.maxOutputTokens)
  let outputCap = inherited ? inherited.maxOutputTokens : deps.maxOutputTokens
  let updated = false
  const automaticPolicy = (compact: CompactionConfig | undefined, binding = metadata()) => compact
    ? resolveCompactSpec(compact, binding?.providerId, binding?.modelId).auto : true
  let compactEnabled = automaticPolicy(deps.compact)
  // M20: budget ladder config (`contextWindow`/`resetRetainLast` are validated
  // at creation above); the default matches the engine convention.
  let budgetCfg = inherited ? inherited.contextWindow === undefined ? undefined : { ...deps.budget, contextWindow: inherited.contextWindow } : deps.budget
  const bindingIsCurrent = () => inheritedBindingCurrent(deps.bindingForStep?.(), inherited, inheritedScalars)
  function refreshBinding() {
    const current = deps.bindingForStep?.()
    if (!current || bindingIsCurrent()) return
    validateBudget(current.contextWindow === undefined ? undefined : { contextWindow: current.contextWindow })
    inheritedScalars = scalarIdentity(current)
    inherited = { ...current, contextMetadata: snapshotModelData(current.contextMetadata), budgetBinding: snapshotModelData(current.budgetBinding) }
    ownedBudget.invalidate()
    budgetCfg = inherited.contextWindow === undefined ? undefined : { ...deps.budget, contextWindow: inherited.contextWindow }
    outputCap = inherited.maxOutputTokens
    compactor = buildCompactor(inheritedCompact(), outputCap)
    compactEnabled = automaticPolicy(deps.compact)
  }

  return {
    execution, contextMeter, projectionRevision, ownedBudget, metadata, refreshBinding, bindingIsCurrent, requestSurfaceFingerprint, captureCandidate,
    readBudget: () => ownedBudget.read(bindingIsCurrent() ? undefined : "Inherited model binding changed before the next logical step"),
    get contextWindow() { return inherited ? inherited.contextWindow : metadata() ? metadata()!.contextWindow : budgetCfg?.contextWindow ?? deps.compact?.contextWindow },
    get reasoningEffort() { return reasoningEffort() },
    get compactor() { return compactor },
    get compactEnabled() { return compactEnabled },
    get budgetCfg() { return budgetCfg },
    get outputCap() { return outputCap },
    update(config: Parameters<NonNullable<Agent["updateContext"]>>[0]) {
      validateBudget(config.budget)
      contextMeter.invalidate()
      ownedBudget.invalidate()
      if (config.maxOutputTokens !== undefined && (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1)) throw new Error("invalid output cap")
      const next = buildCompactor(config.compact, config.maxOutputTokens, "contextMetadata" in config ? config.contextMetadata : metadata(), "budgetBinding" in config ? config.budgetBinding : budgetBinding())
      if ("contextMetadata" in config) {
        hasMetadataOverride = true
        metadataOverride = snapshotModelData(config.contextMetadata)
      }
      if ("budgetBinding" in config) {
        hasBudgetBindingOverride = true
        budgetBindingOverride = snapshotModelData(config.budgetBinding)
      }
      compactor = next
      budgetCfg = config.budget
      outputCap = config.maxOutputTokens
      updated = true
      compactEnabled = automaticPolicy(config.compact, "contextMetadata" in config ? config.contextMetadata : metadata())
    },
  }
}
export type AgentContext = ReturnType<typeof createAgentContext>
