import type { SessionView as Session } from "../managed/types.ts"

export interface SessionTitleView {
  title: string
  messageSeqs: number[]
  source: "fallback" | "provider" | "user"
  eventSeq: number
}

/** Latest-wins session title projection (log-only: never `deriveMessages`-visible). */
export function deriveSessionTitle(session: Session): SessionTitleView | null {
  let view: SessionTitleView | null = null
  for (const ev of session.events) {
    if (ev.type !== "session/title") continue
    view = { title: ev.title, messageSeqs: [...ev.messageSeqs], source: ev.source, eventSeq: ev.seq ?? 0 }
  }
  return view
}
