import {
  createSession, createNondurableFactOwner, isNondurableSession,
  isManagedFactOwner, captureLegacyFact, type SessionView, type Session,
  committedFactSeqs,
} from '@i-harness/core-session'
import { remapConversationSeed, type SessionCoordinator } from '@i-harness/session-persistence'
import { receivedInputsFor } from './received-inputs.ts'

export interface ExecutorDocumentOptions {
  coordinator?: SessionCoordinator
  sessionId?: string
  session?: SessionView
  detachedSession?: Session
}
/** The single main/child/CLI/service attachment factory. External aliases are
 * either the matching managed view or an explicitly detached semantic import. */
export async function openExecutorDocument(options: ExecutorDocumentOptions) {
  if (options.coordinator && options.sessionId) {
    const coordinator = options.coordinator, id = options.sessionId
    if (!coordinator.openManagedDocument) throw Object.assign(new Error('Managed coordinator capability is required'), { code: 'FACT_OWNER_UNSUPPORTED' })
    const document = await coordinator.openManagedDocument(id)
    if (options.detachedSession) {
      if (options.session) throw new Error('Choose owned attachment or explicit detached import')
      const capture = captureLegacyFact(options.detachedSession)
      if (capture.kind !== 'captured') throw Object.assign(new Error('Detached session capture failed'), { code: 'FACT_CAPTURE_FAILED' })
      if (document.view.events.length) throw new Error('Detached import requires an empty owned document')
      const seed = remapConversationSeed({ source: capture.value.events, retained: capture.value.events, sourceFormat: capture.value.formatVersion })
      if (seed.length) committedFactSeqs(await document.importSeed(seed))
    }
    if (options.session && options.session !== document.view) throw Object.assign(new Error('Supplied Session is not this document view; use explicit detached import'), { code: 'FACT_OWNER_UNSUPPORTED' })
    if (!isManagedFactOwner(document.view, document)) throw new Error('Managed document ownership is unavailable')
    return {
      session: document.view, factOwner: document,
      document, inbox: receivedInputsFor(document).inbox,
    }
  }
  const session = options.session ?? options.detachedSession ?? createSession()
  if (!isNondurableSession(session)) throw Object.assign(new Error('Readonly Session requires its actual owned document'), { code: 'FACT_OWNER_UNSUPPORTED' })
  const factOwner = createNondurableFactOwner(session)
  return { session, factOwner, document: undefined, inbox: receivedInputsFor(factOwner).inbox }
}
