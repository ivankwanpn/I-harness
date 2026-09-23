import { deriveMessagesUpTo, type Session } from "@i-harness/core-session"
import type { LLMMessage } from "@i-harness/llm-seam"
import { estimateContent } from "@i-harness/token-meter"

/** Split a region into token-bounded slices of the region's OWN messages.
 *
 * M75: when the single prefix-shaped summarizer request cannot fit the window,
 * the pass summarises the region in pieces instead. Each piece sends only its
 * own messages (a prefix-per-piece shape would re-send everything and is
 * arithmetically incapable of getting under the window).
 *
 * M75 ruling 10: the walk is in MESSAGE space. The region's fold is computed
 * ONCE — the same fold the single-call path replays — and a cut may only fall on
 * a message whose role is `user`. Every piece after the first is therefore a
 * legal standalone request (the provider requires a request's first message to
 * have the `user` role). The FIRST piece starts at the fold's first message,
 * whatever role that is: that is the session's own shape, not the slicing's.
 *
 * M75 ruling 11: a candidate must ALSO leave no tool call open. The same scan
 * carries the outstanding call ids — an `assistant` message adds its
 * `toolCalls`, a `tool` message removes its `toolCallId` — and a `user` message
 * is a candidate only while that set is empty. A `tool` message is normally
 * adjacent to the `assistant(toolCalls)` it belongs to, but the M14
 * tool-result-images shape puts a synthetic `user` message BETWEEN a block's
 * results (`core-session/src/index.ts:578-585`), so without this the cut would
 * leave a piece carrying `tool` with its call behind — the orphan the provider
 * rejects. The guard comes from the same fold the pieces come from, so it cannot
 * drift, and it is what now provides the BLOCK-ALIGNED cut
 * `deriveMessagesUpTo` requires (`core-session/src/index.ts:451-453`): the
 * slicer no longer walks off tool events (that walk was measured insufficient
 * here — `tool/dispatch` ends it early). Cost: a block still open at a candidate
 * makes that candidate unavailable, so a piece can come out coarser than the
 * budget alone would ask.
 *
 * A piece that contains no interior cut candidate (no user message beyond its
 * own first) cannot be split at all, so it is emitted whole and over budget; the
 * caller's fail-soft path already covers the case where even that does not fit.
 * Granularity is therefore bounded by the session's own user-message structure:
 * a single user turn's messages cannot be split.
 */
export function sliceRegion(session: Session, shadowedSeqs: number[], budgetTokens: number): LLMMessage[][] {
  // The region's fold, computed once: everything up to its last named seq —
  // exactly what the single-call path replays (`compactOnce`'s prefix).
  let lastRegionSeq = -1
  for (const seq of shadowedSeqs) if (seq > lastRegionSeq) lastRegionSeq = seq
  if (lastRegionSeq < 0) return []
  const whole = deriveMessagesUpTo(session, lastRegionSeq)
  if (whole.length === 0) return []

  // Cut candidates: the fold's user messages (index 0 excluded — a cut there
  // makes no piece) with NO tool call outstanding. The outstanding set is carried
  // in this same scan, so the guard is computed from the very fold the pieces
  // come from and cannot drift from the projection.
  const bounds: number[] = [0]
  const outstanding = new Set<string>()
  for (let i = 0; i < whole.length; i++) {
    const m = whole[i]!
    if (i > 0 && m.role === "user" && outstanding.size === 0) bounds.push(i)
    if (m.role === "assistant") for (const call of m.toolCalls ?? []) outstanding.add(call.id)
    else if (m.role === "tool") outstanding.delete(m.toolCallId)
  }
  bounds.push(whole.length)

  // Greedy accumulation over the segments between consecutive candidates: close
  // the open piece before a segment that would push it over the budget — unless
  // the open piece is EMPTY, in which case that segment becomes a piece of its
  // own. So a piece is exempt from the budget exactly when it contains no
  // interior candidate: it could not have been split anywhere.
  const pieces: LLMMessage[][] = []
  let start = 0
  let tokens = 0
  for (let k = 0; k + 1 < bounds.length; k++) {
    const at = bounds[k]!
    const segment = whole.slice(at, bounds[k + 1]!)
    const price = estimateContent(segment)
    if (start < at && tokens + price > budgetTokens) {
      pieces.push(whole.slice(start, at))
      start = at
      tokens = 0
    }
    tokens += price
  }
  pieces.push(whole.slice(start))
  return pieces
}
