import { validSoftReductionEvent, type SoftReductionStart, type SoftReductionTerminal } from '../events/soft-reduction.ts'
import type { SessionEventView } from '../managed/types.ts'
import { conversationFormatError as fail } from '../events/conversation.ts'
import type { GenerationHistoryScope } from './generation.ts'
export interface SoftReductionState {
  readonly failures: number; readonly breaker: 'open' | 'closed'; readonly pending: boolean; readonly consumed: ReadonlySet<string>
  readonly lastStart?: SoftReductionStart; readonly lastTerminal?: SoftReductionTerminal
}
interface Sequence { start: SoftReductionStart; terminal?: SoftReductionTerminal }
/** Derived own-session operational state, staged by the existing document index. */
export function createSoftReductionIndex(scope: GenerationHistoryScope = {}) {
  let sequences = new Map<number, Sequence>(), consumed = new Set<string>(), failures = new Map<string, number>()
  let lastStarts = new Map<string, SoftReductionStart>(), lastTerminals = new Map<string, SoftReductionTerminal>()
  const read = (owner: string): SoftReductionState => ({ failures: failures.get(owner) ?? 0, breaker: (failures.get(owner) ?? 0) >= 3 ? 'open' : 'closed',
    pending: [...sequences.values()].some(s => s.start.ownerSessionId === owner && !s.terminal), consumed: new Set([...sequences.values()].filter(s => s.start.ownerSessionId === owner).flatMap(s => [s.start.workKey, ...(s.terminal?.consumedAfterKey ? [s.terminal.consumedAfterKey] : [])])),
    ...(lastStarts.has(owner) ? { lastStart: { ...lastStarts.get(owner)! } } : {}), ...(lastTerminals.has(owner) ? { lastTerminal: { ...lastTerminals.get(owner)! } } : {}) })
  return { read, stage() {
    const next = new Map(sequences), nextConsumed = new Set(consumed)
    const nextFailures = new Map(failures), starts = new Map(lastStarts), terminals = new Map(lastTerminals)
    let previous: SessionEventView | undefined
    return { advance(event: SessionEventView) {
      if (event.type !== 'context/soft-reduction') { previous = event; return }
      if (!validSoftReductionEvent(event) || event.seq === undefined || event.seq < (scope.seedLength ?? 0)
        || scope.sessionId && event.ownerSessionId !== scope.sessionId) fail('invalid own-session soft sequence')
      if (event.op === 'start') {
        if (nextConsumed.has(`${event.ownerSessionId}:${event.workKey}`) || [...next.values()].some(s => s.start.ownerSessionId === event.ownerSessionId && (s.start.sequenceId === event.sequenceId || !s.terminal))) fail('renewed soft sequence')
        const start = { ...event }; starts.set(event.ownerSessionId, start); next.set(event.seq!, { start }); nextConsumed.add(`${event.ownerSessionId}:${event.workKey}`)
      } else {
        const original = next.get(event.startSeq)
        if (!original || original.terminal || original.start.seq! >= event.seq! || original.start.ownerSessionId !== event.ownerSessionId
          || original.start.sequenceId !== event.sequenceId || original.start.workKey !== event.workKey || original.start.sourceKey !== event.sourceKey) fail('invalid soft terminal source')
        if (event.publication === 'committed' && (!previous || !['compaction/replacement', 'compaction/prune', 'compaction/reset'].includes(previous.type))) fail('soft publication must be atomic with rewrite')
        const terminal = { ...event }; terminals.set(event.ownerSessionId, terminal); next.set(event.startSeq, { ...original, terminal })
        if (event.consumedAfterKey) nextConsumed.add(`${event.ownerSessionId}:${event.consumedAfterKey}`)
        if (event.outcome === 'failed') nextFailures.set(event.ownerSessionId, (nextFailures.get(event.ownerSessionId) ?? 0) + 1)
        else if (event.outcome === 'target-ready' && event.publication === 'committed') nextFailures.set(event.ownerSessionId, 0)
      }
      previous = event
    }, commit() { sequences = next; consumed = nextConsumed; failures = nextFailures; lastStarts = starts; lastTerminals = terminals } }
  } }
}
