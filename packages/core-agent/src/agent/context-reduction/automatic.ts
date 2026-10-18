import type { ContextSnapshot, ReductionPolicy } from '@i-harness/context-engine'
import { createConversationValidationIndex, type SessionView, type SessionEventView, type SoftReductionStart } from '@i-harness/core-session'
import { projectionFingerprint } from '@i-harness/token-meter'

/** Private summary addresses normalize to the stable replacement identity. */
export function softWorkFacts(snapshot: ContextSnapshot, policy: ReductionPolicy, conversation: ContextSnapshot['conversation'] = snapshot.conversation) {
  const sourceKey = projectionFingerprint(conversation.items.filter(item => item.messages.length > 0 || item.exchange?.acceptance === 'explicit').map(item => ({
    kind: item.kind, messages: item.messages, state: item.exchange?.state,
    source: item.replacement ? ['replacement', item.replacement.replacementId] : item.sources.map(source => [source.eventIndex, source.part]),
  })))
  const protectionKey = projectionFingerprint(snapshot.protection), policyKey = projectionFingerprint([policy, snapshot.surface])
  return { sourceKey, protectionKey, policyKey, workKey: projectionFingerprint([sourceKey, protectionKey, policyKey]) }
}
export function softAdvances(events: readonly SessionEventView[]) {
  let acceptedExchanges = 0, humanTurns = 0
  const results = new Set(events.flatMap(event => event.type === 'tool/result' && !(event.isError && event.output && typeof event.output === 'object'
    && Object.getOwnPropertyDescriptor(event.output, 'code')?.value === 'TOOL_OUTCOME_UNKNOWN' && Object.getOwnPropertyDescriptor(event.output, 'replay')?.value === false) ? [event.callId] : []))
  for (const event of events) {
    if (event.type === 'turn/end') humanTurns++
    if (event.type === 'model/exchange-accepted' && event.callSeqs.every(seq => {
      const call = events[seq]; return call?.type === 'tool/call' && results.has(call.callId)
    })) acceptedExchanges++
  }
  return { acceptedExchanges, humanTurns }
}
/** Reopen derives the same consumed keys and breaker through the document index. */
export function automaticReductionPolicy(session: SessionView, cooldown: { mode: 'accepted-exchanges' | 'human-turns'; minimum: number }) {
  const read = (owner: string) => createConversationValidationIndex(session.events, { formatVersion: session.formatVersion, header: session.header }).softReduction(owner)
  return {
    allowed(snapshot: ContextSnapshot, policy: ReductionPolicy) {
      const state = read(snapshot.coordinates.ownerSessionId), facts = softWorkFacts(snapshot, policy)
      if (state.pending || state.consumed.has(facts.workKey)) return false
      const lastRewrite = session.events.findLastIndex(event => ['compaction/replacement', 'compaction/prune', 'compaction/end'].includes(event.type))
      if (lastRewrite < 0) return true
      const prior = softAdvances(session.events.slice(0, lastRewrite + 1)), advances = softAdvances(session.events)
      return cooldown.mode === 'human-turns' ? advances.humanTurns - prior.humanTurns >= cooldown.minimum
        : advances.acceptedExchanges - prior.acceptedExchanges >= cooldown.minimum
    },
    start(snapshot: ContextSnapshot, policy: ReductionPolicy, sequenceId: string): SoftReductionStart {
      return { type: 'context/soft-reduction', version: 1, op: 'start', ownerSessionId: snapshot.coordinates.ownerSessionId,
        sequenceId, ...softWorkFacts(snapshot, policy), ...softAdvances(session.events) }
    },
  }
}
