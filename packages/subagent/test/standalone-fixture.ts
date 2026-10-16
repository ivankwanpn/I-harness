import { append, isNondurableSession, type SessionView, type SessionEvent } from '@i-harness/core-session'

/** Only legacy standalone setup may mutate an entry without an owned source. */
export function appendStandalone(session: SessionView, event: SessionEvent): void {
  if (!isNondurableSession(session)) throw new Error('Fixture requires an explicit nondurable session')
  append(session, event)
}
