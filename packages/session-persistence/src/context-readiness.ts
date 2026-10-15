import { CURRENT_FORMAT_VERSION, migrate, type Session } from '@i-harness/core-session'
import type { SessionCoordinator } from './coordinator/types.ts'
/** Composition port: durable readiness first, then explicit in-memory migration. */
export function ownedContextReadiness(coordinator: SessionCoordinator, sessionId: string, session: Session): () => Promise<void> {
  return async () => {
    if (!coordinator.ensureWritableFormat) throw new Error('Owned coordinator must support ensureWritableFormat before context execution')
    const ready = await coordinator.ensureWritableFormat(sessionId)
    if (ready.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error('Owned coordinator did not establish the current session format')
    if (session.formatVersion !== CURRENT_FORMAT_VERSION) Object.assign(session, migrate(session, CURRENT_FORMAT_VERSION))
  }
}
