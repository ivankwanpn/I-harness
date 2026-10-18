import type { ContextSnapshot, ReductionResult } from '@i-harness/context-engine'
import type { SessionView } from '@i-harness/core-session'

const states = new WeakMap<SessionView, { failures: number; paused?: string }>()
/** Existing auto pause/hysteresis policy consumes semantic freshness, never owns reduction. */
export function automaticReductionPolicy(session: SessionView, minimumTurns: number) {
  const state = states.get(session) ?? { failures: 0 }
  states.set(session, state)
  return {
    allowed(snapshot: ContextSnapshot) {
      if (state.paused === snapshot.coordinates.semanticRevision) return false
      let last = -1, turns = 0
      for (const [index, event] of session.events.entries()) {
        if (event.type === 'compaction/replacement' || event.type === 'compaction/prune' || event.type === 'compaction/end') { last = index; turns = 0 }
        else if (last >= 0 && event.type === 'turn/end') turns++
      }
      return last < 0 || turns >= minimumTurns
    },
    record(result: ReductionResult, snapshot: ContextSnapshot, automatic: boolean) {
      if (result.compacted) {
        state.failures = 0
        state.paused = automatic && result.outcome !== 'ready' ? snapshot.coordinates.semanticRevision : undefined
      } else if (automatic && result.reason === 'summarizer-failed') {
        if (++state.failures >= 3) state.paused = snapshot.coordinates.semanticRevision
      }
    },
  }
}
