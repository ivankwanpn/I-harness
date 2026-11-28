import { createExecutionOwner } from "./execution.ts"
import { resolveCompactSpec, type CompactionConfig } from "@i-harness/compaction"
import { contextProjectionRevision, type ContextBindingMetadata } from "@i-harness/core-session"
import type { AgentBudgetConfig, AgentDeps, AgentConfig, Agent, ModelContextBindingDescriptor } from "./types.ts"
import { createOwnedBudget } from "./budget.ts"
import { captureRequestCandidate, rejectUnsupportedRequestContext, sameRequestIdentity, type RequestCandidateIdentity } from "./request-snapshot.ts"
import { readManagedContextSnapshotIdentity } from '@i-harness/context-engine'
import { inputCapacityCeiling, projectionFingerprint } from "@i-harness/token-meter"
import { snapshotModelData } from "@i-harness/llm-seam"
import { agentFacts } from './facts.ts'
import { createContextReduction } from './context-reduction/composition.ts'

const scalarIdentity = (binding: ModelContextBindingDescriptor) => projectionFingerprint({ contextMetadata: binding.contextMetadata, budgetBinding: binding.budgetBinding, contextWindow: binding.contextWindow, maxOutputTokens: binding.maxOutputTokens, reasoningEffort: binding.reasoningEffort })
function inheritedBindingCurrent(current: ModelContextBindingDescriptor | undefined, inherited: ModelContextBindingDescriptor | undefined, scalars: string | undefined): boolean {
  return !current || !!inherited && current.identity === inherited.identity && scalarIdentity(current) === scalars
}

export function validateBudget(budget: AgentBudgetConfig | undefined): void {
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
  const reductionScopes = new WeakMap<import('@i-harness/context-engine').ReductionAttempts, import('@i-harness/llm-seam').LLMRequest['requestScope']>()
  const execution = createExecutionOwner()
  validateBudget(deps.budget)
  const projectionRevision = (): number => contextProjectionRevision(deps.session.events)
  let currentCompact = deps.compact
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
  const requestSurfaceFingerprint = () => projectionFingerprint({ system: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt, baseInstructions: deps.baseInstructions,
    tools: deps.modelToolSchemas?.() ?? deps.tools.schemas(), effort: reasoningEffort(), binding: metadata(), budgetBinding: budgetBinding(), rewrite: projectionRevision() })
  const candidateInput = () => {
    const selected = { model: deps.model, bindingIdentity: deps.modelBindingIdentity?.(), executionIdentity: inherited?.executionIdentity ?? deps.executionIdentity?.() ?? deps.model.executionIdentity }
    const binding = metadata()
    if (currentCompact) resolveCompactSpec(currentCompact, binding?.providerId, binding?.modelId)
    const surface = {
      systemPrompt: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
      ...(deps.baseInstructions === undefined ? {} : { baseInstructions: deps.baseInstructions }),
      tools: deps.modelToolSchemas?.() ?? deps.tools.schemas(), reasoningEffort: reasoningEffort(),
      maxOutputTokens: deps.sharedBudget ? Math.min((inherited ? inherited.maxOutputTokens : updated ? outputCap : deps.maxOutputTokens) ?? 2048, 2048) : inherited ? inherited.maxOutputTokens : updated ? outputCap : deps.maxOutputTokens,
      contextWindow: inherited ? inherited.contextWindow : binding ? binding.contextWindow : budgetCfg?.contextWindow ?? currentCompact?.contextWindow,
      binding, budgetBinding: budgetBinding(),
    }
    return { selected, surface }
  }
  const captureFullCandidate = ({ selected, surface }: ReturnType<typeof candidateInput>) => ({
    ...captureRequestCandidate(deps.session, requestSessionId, selected, surface, projectionRevision()), instructions: deps.requestContext?.capture(),
  })
  const captureCandidate = () => captureFullCandidate(candidateInput())
  const captureCurrentIdentity = (): RequestCandidateIdentity => {
    const input = candidateInput()
    const result = readManagedContextSnapshotIdentity(deps.session, { ownerSessionId: requestSessionId, surface: input.surface })
    if (!result) return captureFullCandidate(input)
    if (result.kind === 'unsupported') rejectUnsupportedRequestContext(result)
    deps.requestContext?.capture()
    const { model, bindingIdentity } = input.selected
    return { model, bindingIdentity, snapshot: result.identity }
  }
  const ownedBudget = createOwnedBudget(deps.session, requestSessionId, captureCurrentIdentity, execution.observationLifetimeId, execution.peekExpected, () => agentFacts(deps), () => deps.sourceFacts)
  const contextMeter = { invalidate: () => ownedBudget.invalidateCalibration() }
  function buildCompactor(compact: CompactionConfig | undefined) {
    return createContextReduction(deps, compact, captureCandidate, ownedBudget, () => bindingIsCurrent(), () => refreshBinding(), attempts => attempts ? reductionScopes.get(attempts) : undefined)
  }
  const inheritedCompact = () => currentCompact && inherited && inputCapacityCeiling(inherited.contextWindow, inherited.budgetBinding?.limits) !== undefined
    ? { ...currentCompact, contextWindow: inherited.contextWindow } : undefined
  let compactor = buildCompactor(inherited ? inheritedCompact() : currentCompact)
  let outputCap = inherited ? inherited.maxOutputTokens : deps.maxOutputTokens
  let updated = false
  const automaticPolicy = (compact: CompactionConfig | undefined, binding = metadata()) => compact
    ? resolveCompactSpec(compact, binding?.providerId, binding?.modelId).auto : true
  let compactEnabled = automaticPolicy(currentCompact)
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
    compactor = buildCompactor(inheritedCompact())
    compactEnabled = automaticPolicy(currentCompact)
  }

  return {
    execution, contextMeter, projectionRevision, ownedBudget, metadata, refreshBinding, bindingIsCurrent, requestSurfaceFingerprint, captureCandidate,
    isCurrentCandidate: (before: RequestCandidateIdentity) => sameRequestIdentity(before, captureCurrentIdentity()),
    bindReductionScope(attempts: import('@i-harness/context-engine').ReductionAttempts, scope: import('@i-harness/llm-seam').LLMRequest['requestScope']) { reductionScopes.set(attempts, scope) },
    readBudget: (includeLastUsage = false) => ownedBudget.read(deps.requestContext && !deps.requestContext.current(deps.requestContext.capture()) ? 'Observed instructions unavailable' : bindingIsCurrent() ? undefined : "Inherited model binding changed before the next logical step", includeLastUsage),
    get contextWindow() { return inherited ? inherited.contextWindow : metadata() ? metadata()!.contextWindow : budgetCfg?.contextWindow ?? currentCompact?.contextWindow },
    get reasoningEffort() { return reasoningEffort() },
    get compactor() { return compactor },
    get compactEnabled() { return compactEnabled },
    get budgetCfg() { return budgetCfg },
    get outputCap() { return outputCap },
    get pressurePolicy() { const binding = metadata(); const policy = currentCompact && resolveCompactSpec(currentCompact, binding?.providerId, binding?.modelId); return policy ? { thresholdRatio: policy.thresholdRatio, targetRatio: policy.targetRatio, cooldown: policy.cooldown } : undefined },
    update(config: Parameters<NonNullable<Agent["updateContext"]>>[0]) {
      validateBudget(config.budget)
      if (config.maxOutputTokens !== undefined && (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1)) throw new Error("invalid output cap")
      const next = buildCompactor(config.compact)
      const selectedMetadata = 'contextMetadata' in config ? config.contextMetadata : metadata()
      if (config.compact) resolveCompactSpec(config.compact, selectedMetadata?.providerId, selectedMetadata?.modelId)
      // The final B2 probe, not a threshold/config edit, owns input-compatible
      // sample retirement. Freshness changes immediately in either case.
      ownedBudget.invalidate(false)
      if ("contextMetadata" in config) {
        hasMetadataOverride = true
        metadataOverride = snapshotModelData(config.contextMetadata)
      }
      if ("budgetBinding" in config) {
        hasBudgetBindingOverride = true
        budgetBindingOverride = snapshotModelData(config.budgetBinding)
      }
      currentCompact = config.compact
      compactor = next
      budgetCfg = config.budget
      outputCap = config.maxOutputTokens
      updated = true
      compactEnabled = automaticPolicy(config.compact, "contextMetadata" in config ? config.contextMetadata : metadata())
    },
  }
}
export type AgentContext = ReturnType<typeof createAgentContext>
