import { isConversationBudget, validAdmissionObservation, type RequestBudgetSnapshotV2 } from '../events/admission.ts'
import { sameAcceptedRequest, validAcceptedRequest, validContextUsageV2, type ContextUsageEventV2, type ProviderReportedUsage } from '../events/attribution.ts'
import type { ExchangeAcceptedEventV2 } from '../events/conversation.ts'
import { contextUsageAnchorId } from '../events/usage-anchor.ts'
import { freezeJsonData } from '../managed/capture.ts'
import type { SessionEventView } from '../managed/types.ts'

type Accepted = Pick<ExchangeAcceptedEventV2, 'seq' | 'exchangeId' | 'actionId' | 'attemptId' | 'request'>
type Sample = Extract<ContextUsageEventV2, { op: 'sample' }>

export type LastProviderInput = { acceptedSeq: number; usageSeq: number; budgetSeq: number; tokens: number; usage: Readonly<ProviderReportedUsage> }
export type ProviderInputState = { accepted?: Accepted; sample?: Sample; reported?: LastProviderInput; conversationReported?: LastProviderInput; supersededAcceptance?: true }

function budgetMatchesUsage(budget: Readonly<RequestBudgetSnapshotV2>, sample: Sample): boolean {
  const { request } = sample.checkpoint
  const { requestContext } = budget, snapshot = request.snapshot
  return budget.purpose === 'main' && budget.freshness === 'awaiting-projection' && budget.ownerSessionId === request.ownerSessionId &&
    budget.projectionRevision === request.projectionRevision && budget.selectedSemanticId === request.semanticId &&
    budget.selectedPayloadId === request.payloadId && requestContext.semanticRevision === snapshot.semanticRevision &&
    requestContext.protectionRevision === snapshot.protectionRevision && requestContext.branchId === snapshot.branchId &&
    requestContext.contextEpoch === snapshot.contextEpoch && requestContext.surfaceRevision === snapshot.surfaceRevision
}

/** These events make all earlier provider-input evidence irrelevant. */
function providerInputBoundary(event: SessionEventView, sessionId: string): ProviderInputState | undefined {
  if (event.type === 'compaction/summary' || event.type === 'compaction/reset' || event.type === 'compaction/prune' ||
    event.type === 'compaction/replacement' || event.type === 'rewind/point') return {}
  if (event.type === 'model/exchange-accepted') {
    if (event.version !== 2) return {}
    if (event.request?.ownerSessionId === sessionId && validAcceptedRequest(event.request)) {
      const { seq, exchangeId, actionId, attemptId, request } = event
      return { accepted: { seq, exchangeId, actionId, attemptId, request } }
    }
  }
  if (event.type === 'context/usage' && event.version === 2 && event.op === 'retire' && event.ownerSessionId === sessionId) return {}
}

function advanceProviderInput(state: ProviderInputState, event: SessionEventView, sessionId: string): ProviderInputState {
  if (event.type === 'context/action' && event.op === 'open' && event.ownerSessionId === sessionId && event.purpose === 'main')
    return { ...state, conversationReported: undefined, ...(state.accepted ? { supersededAcceptance: true as const } : {}) }
  if (event.type === 'context/usage' && event.version === 2 && event.op === 'sample' &&
    event.checkpoint?.request?.ownerSessionId === sessionId && validContextUsageV2(event))
    return state.accepted ? { ...state, sample: event } : {}
  if (event.type === 'context/budget' && event.snapshot.ownerSessionId === sessionId) {
    const { accepted, sample } = state, budgetSeq = event.seq
    // Auxiliary calls carry their own budget. It cannot qualify a main
    // response, but its arrival need not discard an already matched one.
    if (event.version === 2 && state.conversationReported && validAdmissionObservation(event.snapshot) && !isConversationBudget(event.snapshot))
      return { conversationReported: state.conversationReported }
    if (event.version === 2 && accepted?.seq !== undefined && sample?.seq !== undefined && budgetSeq === sample.seq + 1 &&
      accepted.seq < sample.seq && validAdmissionObservation(event.snapshot) && budgetMatchesUsage(event.snapshot, sample)) {
      const { checkpoint } = sample, ref = checkpoint.accepted
      if (accepted.seq === ref.acceptedSeq && accepted.exchangeId === ref.exchangeId && accepted.actionId === ref.actionId &&
        accepted.attemptId === ref.attemptId && sameAcceptedRequest(accepted.request, checkpoint.request) &&
        (checkpoint.cacheReadTokens ?? 0) + (checkpoint.cacheCreationTokens ?? 0) <= checkpoint.reportedInputTokens &&
        contextUsageAnchorId(checkpoint) === checkpoint.anchorId) {
        const usage = Object.freeze({
          inputTokens: checkpoint.reportedInputTokens,
          ...(checkpoint.reportedOutputTokens !== undefined ? {outputTokens: checkpoint.reportedOutputTokens} : {}),
          ...(checkpoint.cacheReadTokens !== undefined ? {cacheReadTokens: checkpoint.cacheReadTokens} : {}),
          ...(checkpoint.cacheCreationTokens !== undefined ? {cacheCreationTokens: checkpoint.cacheCreationTokens} : {}),
        })
        const reported = { acceptedSeq: accepted.seq, usageSeq: sample.seq, budgetSeq, tokens: usage.inputTokens, usage }
        return state.supersededAcceptance ? { reported } : { reported, conversationReported: reported }
      }
    }
    return {}
  }
  return state
}

function foldProviderInput(state: ProviderInputState, events: readonly SessionEventView[], sessionId: string): ProviderInputState {
  let start = 0
  for (let index = events.length - 1; index >= 0; index--) {
    const boundary = providerInputBoundary(events[index]!, sessionId)
    if (!boundary) continue
    state = boundary
    start = index + 1
    break
  }
  if (!state.accepted && !state.reported && !state.conversationReported) return state
  for (let index = start; index < events.length; index++) state = advanceProviderInput(state, events[index]!, sessionId)
  return state
}

/** Keep only detached scalar receipts still needed by the next batch. */
export function stageProviderInput(previous: ProviderInputState, events: readonly SessionEventView[], sessionId: string): ProviderInputState {
  const state = foldProviderInput(previous, events, sessionId)
  const accepted = state.accepted === previous.accepted ? undefined : state.accepted
  const sample = state.sample === previous.sample ? undefined : state.sample
  if (!accepted && !sample) return state
  const captured = freezeJsonData(structuredClone({ accepted, sample }))
  return { ...state, accepted: captured.accepted ?? state.accepted, sample: captured.sample ?? state.sample }
}

export function deriveLastProviderInput(events: readonly SessionEventView[], sessionId: string, select?: 'conversation'): LastProviderInput | undefined {
  const state = foldProviderInput({}, events, sessionId)
  return select === 'conversation' ? state.conversationReported : state.reported
}
