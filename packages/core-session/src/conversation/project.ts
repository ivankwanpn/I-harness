import { eventArchive } from './archive.ts'
import type { SessionView } from '../managed/types.ts'
import { readManagedProjectionHistory } from '../managed/view.ts'
import type { ConversationPayloadCapture } from './payload.ts'
import type { ConversationProjection } from './types.ts'
import { createConversationValidationIndex } from './validation.ts'
import { renderConversationItems } from './render-items.ts'

/** Public projection entry: validate the source before reading payloads. */
export function projectConversation(session: SessionView, options: { ownerSessionId?: string; throughSeq?: number; capturePayload?: ConversationPayloadCapture } = {}): ConversationProjection {
  const index = createConversationValidationIndex(session.events, { formatVersion: session.formatVersion, header: session.header })
  return renderConversationItems(eventArchive(session.events), index.history(options.throughSeq), { ...options, header: session.header })
}

/** Internal full projection of a qualified original managed view. */
export function projectManagedConversation(session: SessionView, options: { ownerSessionId: string; capturePayload?: ConversationPayloadCapture }): ConversationProjection | undefined {
  const { ownerSessionId, capturePayload } = options
  const original = readManagedProjectionHistory(session, ownerSessionId)
  if (!original) return undefined
  const projection = renderConversationItems(eventArchive(session.events), original.history, { ownerSessionId, capturePayload, header: session.header })
  original.assertCurrent()
  return projection
}

/** Select only the current descriptor through the same history/render owners.
 * Runtime reconciliation never reads unrelated historical message payloads. */
export function projectCurrentContext(session: SessionView) {
  const index = createConversationValidationIndex(session.events, { formatVersion: session.formatVersion, header: session.header })
  return renderConversationItems(eventArchive(session.events), { items: [], diagnostics: [], current: index.currentRuntimeContext() }, { header: session.header }).current
}
