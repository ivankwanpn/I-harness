import type { Session } from '../events/types.ts'
import { validSoftReductionEvent, type SoftReductionStart } from '../events/soft-reduction.ts'
import { captureFactGroup, resolveFactGroup } from './groups.ts'
import { installMemoryGroup } from './memory-group.ts'
import type { NondurableFactOutcome } from './ports.ts'

/** Closed optional start capture retains its original result after Stop. */
export function captureMemorySoftStart(session: Session, event: SoftReductionStart, assertOpen: () => void, current: () => boolean) {
  const capture = validSoftReductionEvent(event) && event.op === 'start' && !Object.hasOwn(event, 'seq') ? captureFactGroup({ kind: 'soft-reduction', event }) : { kind: 'not-issued' as const, code: 'FACT_INVALID_GROUP' as const }
  let latest: NondurableFactOutcome | undefined
  const commit = async (): Promise<NondurableFactOutcome> => {
    if (latest) return latest
    try {
      assertOpen()
      if (capture.kind !== 'captured') return latest = capture
      const events = installMemoryGroup(session, resolveFactGroup(capture.group, session, session.events.length), current, true)
      return latest = { kind: 'memory-committed', durability: 'nondurable', seqs: events.map(item => item.seq!) }
    } catch (error) {
      const code = (error as { code?: string }).code
      return latest = { kind: 'not-issued', code: code === 'FACT_CANCELLED' || code === 'FACT_PRECONDITION_STALE' ? code : 'FACT_RECOVERY_REQUIRED' }
    }
  }
  return { admit: commit, reconcile: commit, observe: async () => latest ?? { kind: 'not-issued' as const, code: 'FACT_RECOVERY_REQUIRED' as const } }
}
