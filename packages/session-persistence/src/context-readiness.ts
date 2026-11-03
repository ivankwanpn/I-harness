import { CURRENT_FORMAT_VERSION, type SessionView as Session } from '@i-harness/core-session'
import type { SessionCoordinator } from './coordinator/types.ts'
/** Readiness belongs to the exact owned view established by fenced recovery. */
export function ownedContextReadiness(coordinator: SessionCoordinator, sessionId: string, session: Session): () => Promise<void> {
  return async () => {
    if (!coordinator.openManagedDocument) throw Object.assign(new Error('Owned fact capability is required before context execution'), { code: 'FACT_OWNER_UNSUPPORTED' })
    const document = await coordinator.openManagedDocument(sessionId)
    if (document.view !== session || session.formatVersion !== CURRENT_FORMAT_VERSION) throw Object.assign(new Error('Owned context view does not match this document'), { code: 'FACT_OWNER_UNSUPPORTED' })
    document.assertReady()
  }
}
