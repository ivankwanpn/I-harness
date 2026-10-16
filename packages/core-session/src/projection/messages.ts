import type { SessionView as Session } from "../managed/types.ts"
import type { LLMMessage } from "./types.ts"
import { projectConversation } from "../conversation/project.ts"
import { renderConversation } from "../conversation/render.ts"

/** Prefix view: prune directives are content-addressed; summary/reset are timed.
 * The semantic projector preserves that exception without reindexing sources.
 */
export function deriveMessagesUpTo(session: Session, maxSeq: number): LLMMessage[] {
  return renderConversation(projectConversation(session, { throughSeq: maxSeq }))
}

export function deriveMessages(session: Session): LLMMessage[] {
  return renderConversation(projectConversation(session))
}
