import { append, committedFactSeqs, createNondurableFactOwner, createSession, isNondurableSession, type SessionEvent, type SessionView } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { ChildAgentEntry } from '../agent-table.ts'

/** Child composition attaches to the coordinator's sole owner. Inherited facts
 * are structurally remapped by forkTurns before this receipt boundary. */
export async function openChildDocument(seed: readonly SessionEvent[], header: NonNullable<SessionView['header']>, durable?: { coordinator: SessionCoordinator; sessionId: string }) {
  if (durable) {
    const document = await durable.coordinator.openManagedDocument(durable.sessionId)
    if (seed.length) committedFactSeqs(await document.importSeed(seed))
    return { session: document.view, factOwner: document, document }
  }
  const session = createSession()
  session.header = header
  for (const event of seed) append(session, event)
  return { session, factOwner: createNondurableFactOwner(session), document: undefined }
}

export async function childFactOwner(entry: ChildAgentEntry, coordinator?: SessionCoordinator) {
  if (entry.factOwner?.view === entry.session) return entry.factOwner
  if (entry.sessionId && coordinator) {
    const document = await coordinator.openManagedDocument(entry.sessionId)
    if (entry.session !== document.view) throw Object.assign(new Error('Child requires its owned document view'), { code: 'FACT_OWNER_UNSUPPORTED' })
    entry.factOwner = document
    return document
  }
  if (!isNondurableSession(entry.session)) throw Object.assign(new Error('Child requires owned facts'), { code: 'FACT_OWNER_UNSUPPORTED' })
  return entry.factOwner = createNondurableFactOwner(entry.session)
}
