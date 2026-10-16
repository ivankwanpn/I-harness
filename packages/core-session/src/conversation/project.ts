import type { SessionView } from '../managed/types.ts'
import type { ConversationPayloadCapture } from './payload.ts'
import type { ConversationProjection } from './types.ts'
import { validateConversationHistory } from './validation.ts'
import { renderConversationItems } from './render-items.ts'

/** Public projection entry: validate the source before reading payloads. */
export function projectConversation(session: SessionView, options: { ownerSessionId?: string; throughSeq?: number; capturePayload?: ConversationPayloadCapture } = {}): ConversationProjection {
  validateConversationHistory(session.events, session.formatVersion)
  return renderConversationItems(session, options)
}