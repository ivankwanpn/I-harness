import type { Session } from '../events/types.ts'
import { installMemoryGroup } from './memory-group.ts'
import { captureFactGroup, resolveFactGroup, type ContextReductionDraft } from './groups.ts'
import type { NondurableFactOutcome } from './ports.ts'
import { validContextReductionDraft } from './reduction.ts'

/** Explicit memory owner stages the full group and installs before observers. */
export function captureMemoryReduction(session: Session, draft: ContextReductionDraft, assertOpen: () => void, current: () => boolean) {
  const capture = validContextReductionDraft(draft) ? captureFactGroup(draft) : { kind: 'not-issued' as const, code: 'FACT_INVALID_GROUP' as const }
  let latest: NondurableFactOutcome | undefined
  const commit = async (): Promise<NondurableFactOutcome> => {
    if (latest) return latest
    try {
      assertOpen()
      if (capture.kind !== 'captured') return latest = capture
      const events = installMemoryGroup(session, resolveFactGroup(capture.group, session, session.events.length), current, true)
      latest = { kind: 'memory-committed', durability: 'nondurable', seqs: events.map(event => event.seq!) }
      return latest
    } catch (error) {
      const code = (error as { code?: string }).code
      return latest = { kind: 'not-issued', code: code === 'FACT_CANCELLED' || code === 'FACT_PRECONDITION_STALE' ? code : 'FACT_RECOVERY_REQUIRED' }
    }
  }
  return { admit: commit, reconcile: commit, observe: async () => latest ?? { kind: 'not-issued' as const, code: 'FACT_RECOVERY_REQUIRED' as const } }
}
