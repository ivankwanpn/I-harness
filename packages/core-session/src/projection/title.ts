import type { SessionView as Session } from "../managed/types.ts"

export interface SessionTitleView {
  title: string
  messageSeqs: number[]
  source: "fallback" | "provider" | "user"
  eventSeq: number
}

export function applySessionTitleProjection(view: SessionTitleView | null, ev: import('../managed/types.ts').SessionEventView): SessionTitleView | null {
  if (ev.type !== 'session/title') return view
  return { title: ev.title, messageSeqs: [...ev.messageSeqs], source: ev.source, eventSeq: ev.seq ?? 0 }
}

/** Latest-wins session title projection (log-only: never `deriveMessages`-visible). */
export function deriveSessionTitle(session: Session): SessionTitleView | null {
  let view: SessionTitleView | null = null
  for (const ev of session.events) {
    view = applySessionTitleProjection(view, ev)
  }
  return view
}
