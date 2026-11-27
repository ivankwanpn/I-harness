import { eventArchive } from './archive.ts'
import type { SessionView } from '../managed/types.ts'
import { readManagedProjectionHistory, unchangedDataPrototypes } from '../managed/view.ts'
import type { ConversationPayloadCapture } from './payload.ts'
import type { ConversationProjection } from './types.ts'
import { createConversationValidationIndex } from './validation.ts'
import { renderConversationItems } from './render-items.ts'
import { captureData, hasOriginalClosedCaptureOperations } from '../serialization/context-data.ts'

/** Public projection entry: validate the source before reading payloads. */
export function projectConversation(session: SessionView, options: { ownerSessionId?: string; throughSeq?: number; capturePayload?: ConversationPayloadCapture } = {}): ConversationProjection {
  const index = createConversationValidationIndex(session.events, { formatVersion: session.formatVersion, header: session.header })
  return renderConversationItems(eventArchive(session.events), index.history(options.throughSeq), { ...options, header: session.header })
}

/** Internal full projection of a qualified original managed view. */
export function projectManagedConversation(session: SessionView, options: { ownerSessionId: string; capturePayload?: ConversationPayloadCapture }): ConversationProjection | undefined {
  return projectOriginalManagedConversation(session, options, false)
}

/** The request snapshot owns its payload reader and its last refusal coordinate. */
export function prepareManagedConversationCapture() {
  let sourceId: string | undefined
  const capturePayload: ConversationPayloadCapture = (value, source) => {
    sourceId = source.id
    return captureData(value)
  }
  return {
    capturePayload,
    project: (session: SessionView, ownerSessionId: string) => projectOriginalManagedConversation(session, { ownerSessionId, capturePayload }, true),
    sourceIds: () => sourceId === undefined ? [] : [sourceId],
  }
}

function projectOriginalManagedConversation(session: SessionView, options: { ownerSessionId: string; capturePayload?: ConversationPayloadCapture }, captureClosed: boolean): ConversationProjection | undefined {
  const { ownerSessionId, capturePayload } = options
  const original = readManagedProjectionHistory(session, ownerSessionId)
  if (!original) return undefined
  const constructClosed = captureClosed && hasOriginalClosedCaptureOperations() && unchangedDataPrototypes()
  const projection = renderConversationItems(eventArchive(session.events), original.history, { ownerSessionId, capturePayload, header: session.header }, constructClosed)
  original.assertCurrent()
  return projection
}

/** Select only the current descriptor through the same history/render owners.
 * Runtime reconciliation never reads unrelated historical message payloads. */
export function projectCurrentContext(session: SessionView) {
  const index = createConversationValidationIndex(session.events, { formatVersion: session.formatVersion, header: session.header })
  return renderConversationItems(eventArchive(session.events), { items: [], diagnostics: [], current: index.currentRuntimeContext() }, { header: session.header }).current
}
