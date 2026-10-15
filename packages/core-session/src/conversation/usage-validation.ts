import { sameAcceptedRequest, type AcceptedRequestAttributionV1, type ContextUsageEventV2 } from '../events/attribution.ts'
import { validContextEvent } from '../events/context.ts'
import { conversationFormatError as fail } from '../events/conversation.ts'
import { contextUsageAnchorId } from '../events/usage-anchor.ts'
import type { SessionEvent } from '../events/types.ts'
export interface AcceptanceFact {
  index: number; exchangeId: string; actionId: string; attemptId: string; stepStartSeq: number
  assistantSeq: number; callSeqs: string; request: AcceptedRequestAttributionV1
}
export interface UsageAnchorFact { owner: string; branch: string; epoch: string; retired: boolean }
/** Pure validation over the existing structural index's staged facts and the
 * current operation's referenced event. No event archive or independent index. */
export function validateUsageFact(event: ContextUsageEventV2, position: number, input: {
  accepted?: AcceptanceFact; actual?: SessionEvent; requireCurrent: boolean
  anchor?: UsageAnchorFact; completedAnchorId?: string
}): UsageAnchorFact {
  if (!validContextEvent(event)) fail('invalid usage v2 payload')
  if (event.op === 'retire') {
    const old = input.anchor
    if (!old || old.owner !== event.ownerSessionId || old.branch !== event.branchId || old.epoch !== event.contextEpoch) fail('invalid retirement ownership')
    return { ...old, retired: true }
  }
  const c = event.checkpoint, ref = c.accepted, accepted = input.accepted, actual = input.actual
  if (contextUsageAnchorId(c) !== c.anchorId) fail('invalid sample identity')
  if (!accepted || ref.acceptedSeq >= event.seq! || accepted.index >= position || accepted.exchangeId !== ref.exchangeId || accepted.actionId !== ref.actionId || accepted.attemptId !== ref.attemptId || !sameAcceptedRequest(accepted.request, c.request)) fail('invalid usage acceptance reference')
  if (actual && (actual.type !== 'model/exchange-accepted' || actual.version !== 2 || actual.seq !== ref.acceptedSeq || actual.exchangeId !== accepted.exchangeId || actual.actionId !== accepted.actionId || actual.attemptId !== accepted.attemptId || actual.stepStartSeq !== accepted.stepStartSeq || actual.assistantSeq !== accepted.assistantSeq || JSON.stringify(actual.callSeqs) !== accepted.callSeqs || !sameAcceptedRequest(actual.request, accepted.request))) fail('referenced acceptance was mutated')
  if (input.requireCurrent && !actual) fail('missing current acceptance reference')
  if (input.anchor?.retired || input.completedAnchorId && input.completedAnchorId !== c.anchorId) fail('contradictory or retired sample')
  return { owner: c.request.ownerSessionId, branch: c.request.snapshot.branchId, epoch: c.request.snapshot.contextEpoch, retired: false }
}
