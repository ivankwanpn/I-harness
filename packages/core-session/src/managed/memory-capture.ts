import { append } from '../events/append.ts'
import type { Session } from '../events/types.ts'
import { captureFactGroup, resolveFactGroup, type FactGroupDraft } from './groups.ts'
import type { NondurableFactOutcome } from './ports.ts'

/** Once-lowered standalone data. No receipt or durable authority is created. */
export function captureMemoryFact(session: Session, draft: FactGroupDraft, assertHeld: () => void) {
  const capture = captureFactGroup(draft)
  let result: Promise<NondurableFactOutcome> | undefined
  const commit = () => {
    assertHeld()
    return result ??= (async () => {
      if (capture.kind !== 'captured') return capture
      const events = resolveFactGroup(capture.group, session, session.events.length)
      for (const item of events) append(session, item)
      return { kind: 'memory-committed' as const, durability: 'nondurable' as const, seqs: events.map(item => item.seq!) }
    })()
  }
  return { admit: commit, reconcile: commit, retryAbsent: commit, observe: () => result ?? Promise.resolve({ kind: 'not-issued' as const, code: 'FACT_RECOVERY_REQUIRED' as const }) }
}

export function rejectedMemoryCapture() {
  const invalid = async () => ({ kind: 'not-issued' as const, code: 'FACT_INVALID_GROUP' as const })
  return { admit: invalid, reconcile: invalid, observe: invalid, retryAbsent: invalid }
}
