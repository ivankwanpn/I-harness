import { eventArchive } from './archive.ts'
import type { SessionView } from '../managed/types.ts'
import type { ConversationPayloadCapture } from './payload.ts'
import type { ConversationProjection } from './types.ts'
import { createConversationValidationIndex } from './validation.ts'
import { renderConversationItems } from './render-items.ts'

/** Public projection entry: validate the source before reading payloads. */
export function projectConversation(session: SessionView, options: { ownerSessionId?: string; throughSeq?: number; capturePayload?: ConversationPayloadCapture } = {}): ConversationProjection {
  const index = createConversationValidationIndex(session.events, { formatVersion: session.formatVersion, header: session.header })
  return renderConversationItems(eventArchive(session.events), index.history(options.throughSeq), { ...options, header: session.header })
}
