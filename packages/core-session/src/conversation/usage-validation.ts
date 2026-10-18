import { sameAcceptedRequest, type AcceptedRequestAttributionV1, type ContextUsageEventV2 } from '../events/attribution.ts'
import { validContextEvent } from '../events/context.ts'
import { conversationFormatError as fail } from '../events/conversation.ts'
import { contextUsageAnchorId } from '../events/usage-anchor.ts'
import type { SessionEventView as SessionEvent } from "../managed/types.ts"
export interface AcceptanceFact {
  index: number
  exchangeId: string
  actionId: string
  attemptId: string
  stepStartSeq: number
  assistantSeq: number
  callSeqs: string
  request: AcceptedRequestAttributionV1
}
export interface UsageAnchorFact {
  owner: string
  branch: string
  epoch: string
  retired: boolean
}
/** Pure validation over the existing structural index's staged facts and the
 * current operation's referenced event. No event archive or independent index. */
export function validateUsageFact(event: ContextUsageEventV2, position: number, input: {
  accepted?: AcceptanceFact
  actual?: SessionEvent
  requireCurrent: boolean
  anchor?: UsageAnchorFact
  completedAnchorId?: string
}): UsageAnchorFact {
  if (!validContextEvent(event)) fail('invalid usage v2 payload')
  if (event.op === 'retire') {
    const old = input.anchor
    if (!old
      || old.owner !== event.ownerSessionId
      || old.branch !== event.branchId
      || old.epoch !== event.contextEpoch) fail('invalid retirement ownership')
    return { ...old, retired: true }
  }
  const checkpoint = event.checkpoint
  const reference = checkpoint.accepted
  const { accepted, actual } = input
  if (contextUsageAnchorId(checkpoint) !== checkpoint.anchorId) fail('invalid sample identity')
  if (!accepted
    || reference.acceptedSeq >= event.seq!
    || accepted.index >= position
    || accepted.exchangeId !== reference.exchangeId
    || accepted.actionId !== reference.actionId
    || accepted.attemptId !== reference.attemptId
    || !sameAcceptedRequest(accepted.request, checkpoint.request)) fail('invalid usage acceptance reference')
  if (actual) {
    if (actual.type !== 'model/exchange-accepted' || actual.version !== 2) fail('referenced acceptance was mutated')
    const unchanged = actual.seq === reference.acceptedSeq
      && actual.exchangeId === accepted.exchangeId
      && actual.actionId === accepted.actionId
      && actual.attemptId === accepted.attemptId
      && actual.stepStartSeq === accepted.stepStartSeq
      && actual.assistantSeq === accepted.assistantSeq
      && JSON.stringify(actual.callSeqs) === accepted.callSeqs
      && sameAcceptedRequest(actual.request, accepted.request)
    if (!unchanged) fail('referenced acceptance was mutated')
  }
  if (input.requireCurrent && !actual) fail('missing current acceptance reference')
  if (input.anchor?.retired
    || input.completedAnchorId && input.completedAnchorId !== checkpoint.anchorId) fail('contradictory or retired sample')
  return {
    owner: checkpoint.request.ownerSessionId,
    branch: checkpoint.request.snapshot.branchId,
    epoch: checkpoint.request.snapshot.contextEpoch,
    retired: false,
  }
}
