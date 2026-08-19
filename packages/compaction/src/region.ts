import type { Session, SessionEvent } from "@i-harness/core-session"
import { deriveSearchText } from "@i-harness/core-session"
import { approxTokens } from "./tokens.ts"

function isCompactionMarker(ev: SessionEvent): boolean {
  return ev.type === "compaction/start" || ev.type === "compaction/end" || ev.type === "compaction/summary"
}

// Events strictly before the first event whose cumulative tail crosses the
// retention budget are shadowable (compaction markers never are). An empty
// budget shadows everything except markers; a budget covering the whole
// session shadows nothing.
export function selectShadowableRange(session: Session, retainTokens: number): number[] {
  const shadowed: number[] = []
  if (retainTokens <= 0) {
    for (const ev of session.events) {
      if (ev.seq === undefined || isCompactionMarker(ev)) continue
      shadowed.push(ev.seq)
    }
    return shadowed
  }
  let tail = 0
  let firstRetainedSeq: number | null = null
  for (let i = session.events.length - 1; i >= 0; i--) {
    const ev = session.events[i]!
    if (isCompactionMarker(ev)) continue
    tail += approxTokens(deriveSearchText(ev))
    if (tail >= retainTokens) {
      firstRetainedSeq = ev.seq ?? i
      break
    }
  }
  if (firstRetainedSeq === null) return shadowed
  for (const ev of session.events) {
    if (ev.seq === undefined || isCompactionMarker(ev)) continue
    if (ev.seq < firstRetainedSeq) shadowed.push(ev.seq)
  }
  return shadowed
}
