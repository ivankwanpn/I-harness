import type { Session } from '../events/types.ts'
import { appendHooks, subscribers, conversationIndexes } from '../events/state.ts'
import { createConversationIndex } from '../conversation/validation.ts'
import { prepareSessionEvent } from '../events/intake.ts'
import { captureFactGroup, resolveFactGroup, type ContextReductionDraft } from './groups.ts'
import type { NondurableFactOutcome } from './ports.ts'

/** Explicit memory owner stages the full group and installs before observers. */
export function captureMemoryReduction(session: Session, draft: ContextReductionDraft, assertOpen: () => void, current: () => boolean) {
  const capture = captureFactGroup(draft)
  let latest: NondurableFactOutcome | undefined
  const commit = async (): Promise<NondurableFactOutcome> => {
    if (latest) return latest
    try {
      assertOpen()
      if (capture.kind !== 'captured') return latest = capture
      const events = resolveFactGroup(capture.group, session, session.events.length).map((event, i) => prepareSessionEvent(session, event, session.events.length + i))
      const index = createConversationIndex(session.events, position => session.events[position], session.formatVersion), staged = index.stage(events)
      if (!current()) return latest = { kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' }
      // No await or untrusted callback may intervene in this standalone install.
      staged.commit(); session.events.push(...events)
      conversationIndexes.set(session, { formatVersion: session.formatVersion, events: session.events, index })
      latest = { kind: 'memory-committed', durability: 'nondurable', seqs: events.map(event => event.seq!) }
      for (const event of events) for (const observer of [appendHooks.get(session), ...subscribers.get(session) ?? []]) {
        if (observer) try { Promise.resolve(observer(event)).catch(() => {}) } catch { /* Installed memory facts remain known. */ }
      }
      return latest
    } catch (error) {
      const code = (error as { code?: string }).code
      return latest = { kind: 'not-issued', code: code === 'FACT_CANCELLED' ? code : 'FACT_RECOVERY_REQUIRED' }
    }
  }
  return { admit: commit, reconcile: commit, observe: async () => latest ?? { kind: 'not-issued' as const, code: 'FACT_RECOVERY_REQUIRED' as const } }
}
