import type { Session, SessionEvent } from "@i-harness/core-session"
import { deriveSearchText } from "@i-harness/core-session"
import { approxTokens } from "./tokens.ts"

function isCompactionMarker(ev: SessionEvent): boolean {
  // M20 fix round 1: a pure reset is also a compaction marker — it must never
  // be shadow-summarized, priced into the shadow-range tail walk (it carries
  // no text), and alone must not re-arm maybeCompact's re-fire guard.
  // M33: `compaction/prune` joins the same class — never shadowed, never
  // priced into the tail walk, never re-arms the re-fire guard.
  return ev.type === "compaction/start" || ev.type === "compaction/end" || ev.type === "compaction/summary" || ev.type === "compaction/reset" || ev.type === "compaction/prune"
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
      // M5/D2: walk BACK off any tool event before cutting. deriveMessages folds
      // assistant(toolCalls) together with its tool(result) messages, but this
      // walk counts events — so a cut on a `tool/result` retains a result whose
      // call was just shadowed, and llm-anthropic renders that as a tool_result
      // block with no tool_use. Same rule as resetWindowOnce, same reason.
      // Measured on a 12-turn tool session: 50/150/300/900 all orphan, while 500
      // lands on a `tool/call` and survives — by arithmetic, not by design.
      let j = i
      while (j > 0) {
        const at = session.events[j]!
        if (at.type !== "tool/call" && at.type !== "tool/result") break
        j -= 1
      }
      firstRetainedSeq = session.events[j]!.seq ?? j
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
