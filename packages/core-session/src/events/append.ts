import { CURRENT_FORMAT_VERSION } from "./types.ts"
import type { Session, SessionEvent } from "./types.ts"
import { appendHooks, subscribers, conversationIndexes, managedSessions } from "./state.ts"
import { createConversationIndex } from "../conversation/validation.ts"
import { prepareSessionEvent } from "./intake.ts"

export function createSession(onAppend?: (ev: SessionEvent) => void): Session {
  const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events: [] }
  if (onAppend) appendHooks.set(session, onAppend)
  return session
}

export function append(session: Session, event: SessionEvent): void {
  if (managedSessions.has(session)) throw new TypeError('Managed Session requires asynchronous fact admission')
  const ev = prepareSessionEvent(session, event, session.events.length)
  let cached = conversationIndexes.get(session)
  const header = session.header as typeof session.header & { sessionId?: string }
  if (!cached || cached.formatVersion !== session.formatVersion || cached.events !== session.events || cached.index.eventCount !== session.events.length
    || cached.index.generationScope !== JSON.stringify([header?.sessionId, header?.parentSession, header?.seedLength])) {
    cached = { formatVersion: session.formatVersion, events: session.events, index: createConversationIndex(session.events, index => session.events[index], session.formatVersion, header) }
    conversationIndexes.set(session, cached)
  }
  const staged = cached.index.stage([ev])
  session.events.push(ev)
  staged.commit()
  appendHooks.get(session)?.(ev)
  subscribers.get(session)?.forEach((l) => l(ev))
}
