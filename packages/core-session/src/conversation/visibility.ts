import type { SessionView } from '../managed/types.ts'
import { historyVisibility } from './history/visibility.ts'

/** R1C state reads and logical projection share the same visibility owner. */
export function conversationVisibility(session: SessionView, throughSeq?: number) {
  return historyVisibility(session.events, throughSeq)
}
export type ConversationVisibility = ReturnType<typeof conversationVisibility>