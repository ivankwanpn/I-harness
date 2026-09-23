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
 * a message whose role is `user`. Two properties follow by construction rather
 * than from a boundary rule: every piece after the first is a legal standalone
 * request (the provider requires a request's first message to have the `user`
 * role), and no cut can land inside an `assistant(toolCalls)` / `tool` pair —
 * those are adjacent in the fold — so no piece begins with an orphan `tool`
 * message. The FIRST piece starts at the fold's first message, whatever role
 * that is: that is the session's own shape, not the slicing's.
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
  // makes no piece). In message space a cut can never sit inside a call/result
  // pair, whatever the log's event shapes are.
  const bounds: number[] = [0]
  for (let i = 1; i < whole.length; i++) if (whole[i]!.role === "user") bounds.push(i)
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
