import { reduceContext, resetContext, type ReductionRunOptions } from '@i-harness/context-engine'
import { resolveCompactSpec, type CompactionConfig, type CompactionEngine } from '@i-harness/compaction'
import { mapModelRequest } from '@i-harness/llm-seam'
import type { AgentConfig, AgentDeps } from '../types.ts'
import type { createOwnedBudget } from '../budget.ts'
import type { RequestEvidence } from '../request-snapshot.ts'
import { createReductionBridge } from './bridge.ts'
import { automaticReductionPolicy } from './automatic.ts'
import { projectionFingerprint } from '@i-harness/token-meter'
import type { ContextSnapshot } from '@i-harness/context-engine'

export function createContextReduction(deps: AgentDeps & AgentConfig, config: CompactionConfig | undefined, capture: () => RequestEvidence, budget: ReturnType<typeof createOwnedBudget>, bindingCurrent: () => boolean, refresh = () => {}, scope: (attempts?: import('@i-harness/context-engine').ReductionAttempts) => import('@i-harness/llm-seam').LLMRequest['requestScope'] = () => undefined): CompactionEngine | undefined {
  if (!config) return undefined
  resolveCompactSpec(config)
  const run = async (options?: ReductionRunOptions, instructions?: string) => {
    refresh()
    if (!deps.captureContextReduction) return { compacted: false, shadowedSeqs: [], outcome: 'blocked' as const, publication: 'none' as const, blockedReason: 'publication-unavailable' as const }
    let evidence: RequestEvidence
    try { evidence = capture() }
    catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'CONTEXT_SNAPSHOT_UNSUPPORTED' || code === 'CONTEXT_STATE_AMBIGUOUS') return { compacted:false,shadowedSeqs:[],outcome:'blocked' as const,publication:'none' as const,blockedReason:code === 'CONTEXT_SNAPSHOT_UNSUPPORTED' ? 'opaque' as const : 'source-unrepresentable' as const }
      throw error
    }
    const metadata = evidence.metadata, resolved = resolveCompactSpec(config, metadata?.providerId, metadata?.modelId)
    const policy = { retainTokens: resolved.retainTokens, thresholdRatio: resolved.thresholdRatio, reserveRatio: deps.budget?.reserveRatio, prune: resolved.prune }
    const ports = createReductionBridge(deps, capture, budget, bindingCurrent, policy, options?.signal ?? deps.signal, refresh, !resolved.summarizationModel || resolved.summarizationModel === evidence.model, scope(options?.attempts))
    const automatic = automaticReductionPolicy(deps.session, resolved.minTurnsBeforeRecompact)
    if (options?.reason === 'auto' && !automatic.allowed(evidence.snapshot)) return { compacted: false, shadowedSeqs: [], outcome: 'unchanged' as const, publication: 'none' as const }
    const sourceCapture = ports.capture
    const sourceCurrent = ports.current, summaryOwners = new WeakMap<ContextSnapshot, { model: typeof resolved.summarizationModel; identity: string }>()
    const summaryState = (snapshot: ContextSnapshot) => {
      const value = resolveCompactSpec(config, snapshot.surface.binding?.providerId, snapshot.surface.binding?.modelId)
      return { model: value.summarizationModel, identity: projectionFingerprint([value.summaryMetadata, value.summaryBudgetBinding, value.summaryLimits, value.summaryReasoningEffort, value.summaryMaxOutputTokens, value.maxTokens, value.minSummaryChars]) }
    }
    ports.current = (snapshot, groups) => { const prior = summaryOwners.get(snapshot), now = summaryState(snapshot); return sourceCurrent(snapshot, groups) && !!prior && prior.model === now.model && prior.identity === now.identity }
    ports.capture = () => {
      const snapshot = sourceCapture(), selected = resolveCompactSpec(config, snapshot.surface.binding?.providerId, snapshot.surface.binding?.modelId)
      Object.assign(policy, { retainTokens: selected.retainTokens, thresholdRatio: selected.thresholdRatio, prune: selected.prune })
      summaryOwners.set(snapshot, summaryState(snapshot))
      return snapshot
    }
    ports.summary = deps.summaryFactory ? source => {
      const selected = capture(), surface = selected.snapshot.surface
      const configuration = resolveCompactSpec({ ...config, contextWindow: surface.contextWindow ?? config.contextWindow }, selected.metadata?.providerId, selected.metadata?.modelId)
      const model = deps.sessionId === undefined ? selected.model : mapModelRequest(selected.model, request => ({ ...request, sessionId: request.sessionId ?? deps.sessionId }))
      return deps.summaryFactory!({ model, config: configuration.summarizationModel === selected.model ? { ...configuration, summarizationModel: model } : configuration,
        generation: deps.sharedBudget?.control ?? deps.generationAction?.control('summary'),
        bindGeneration: deps.sharedBudget ? prepared => deps.sharedBudget!.bind(prepared, 'summary') : deps.generationAction ? prepared => deps.generationAction!.bind(prepared, 'summary') : undefined,
        contextMetadata: selected.metadata, budgetBinding: surface.budgetBinding, maxOutputTokens: surface.maxOutputTokens, reasoningEffort: surface.reasoningEffort,
        flush: deps.flush, telemetry: deps.telemetry ? { close() {}, emit(event) { deps.telemetry!.emit({ ...event, data: { ...event.data, sessionId: deps.sessionId } }) } } : undefined })(source)
    } : undefined
    const started = Date.now(), attempts = options?.attempts ?? { count: 0, staleRebuilds: 0 }, firstCount = attempts.count
    let before: number | undefined, after: number | undefined, pruned = 0
    const prepare = ports.prepare, publish = ports.publish
    ports.prepare = async (...args) => { const value = await prepare(...args); if (value.kind === 'assessed') { before ??= value.inputTokens; after = value.inputTokens }; return value }
    ports.publish = async (...args) => { const value = await publish(...args); if (value.kind === 'committed' || value.kind === 'nondurable') for (const draft of args[2]) if (draft.type === 'compaction/prune') pruned += draft.pruned.length; return value }
    const result = await reduceContext(ports, policy, { ...options, attempts }, instructions)
    automatic.record(result, capture().snapshot, options?.reason === 'auto')
    deps.telemetry?.emit({ type: 'compaction/attempt', ts: Date.now(), data: { reason: options?.reason, outcome: result.compacted ? result.summary ? 'success' : 'prune-only' : result.reason ? 'failure' : 'skipped',
      tokensBefore: before, tokensAfter: result.compacted ? after : before, attempts: attempts.count - firstCount, durationMs: Date.now() - started, shadowed: result.shadowedSeqs.length, pruned,
      outcomeState: result.outcome, publication: result.publication, ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}) } })
    return result
  }
  return {
    maybeCompact: (_session, options) => run({ ...options, reason: 'auto' }),
    compact: (_session, instructions, options) => run({ ...options, reason: options?.reason ?? 'manual' }, instructions),
    recover: (_session, options) => run({ ...options, reason: 'recovery' }),
    resetWindow: (_session, retainLast) => resetContext(createReductionBridge(deps, capture, budget, bindingCurrent, {}, deps.signal, refresh), retainLast),
  }
}
