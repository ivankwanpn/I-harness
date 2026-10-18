import type { Session, SessionEvent } from '../events/types.ts'
import { appendHooks, subscribers, conversationIndexes } from '../events/state.ts'
import { createConversationIndex } from '../conversation/validation.ts'
import { prepareSessionEvent } from '../events/intake.ts'

/** One standalone install over the same structural index, before observers.
 * This has no disk receipt and never substitutes for managed admission. */
export function installMemoryGroup(session: Session, drafts: readonly SessionEvent[], current: () => boolean = () => true, ignoreObserverErrors = false): readonly SessionEvent[] {
  const events = drafts.map((event, offset) => prepareSessionEvent(session, event, session.events.length + offset))
  const header = session.header as typeof session.header & { sessionId?: string }
  let cached = conversationIndexes.get(session)
  if (!cached || cached.formatVersion !== session.formatVersion || cached.events !== session.events || cached.index.eventCount !== session.events.length
    || cached.index.generationScope !== JSON.stringify([header?.sessionId, header?.parentSession, header?.seedLength])) {
    cached = { formatVersion: session.formatVersion, events: session.events, index: createConversationIndex(session.events, position => session.events[position], session.formatVersion, header) }
  }
  const staged = cached.index.stage(events)
  if (!current()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' })
  staged.commit(); session.events.push(...events); conversationIndexes.set(session, cached)
  for (const event of events) for (const observer of [appendHooks.get(session), ...subscribers.get(session) ?? []]) {
    if (observer) try { Promise.resolve(observer(event)).catch(() => {}) } catch (error) { if (!ignoreObserverErrors) throw error }
  }
  return events
}
