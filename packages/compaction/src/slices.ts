import { deriveMessagesUpTo, type Session } from "@i-harness/core-session"
import type { LLMMessage } from "@i-harness/llm-seam"
import { estimateContent } from "@i-harness/token-meter"
import { walkOffToolEvents } from "./region.ts"

/** Split a region into token-bounded slices of the region's OWN messages.
 *
 * M75: when the single prefix-shaped summarizer request cannot fit the window,
 * the pass summarises the region in pieces instead. Each piece sends only its
 * own messages (a prefix-per-piece shape would re-send everything and is
 * arithmetically incapable of getting under the window).
 *
 * Cuts fall on BLOCK boundaries: a `tool/result` whose `tool/call` lives in the
 * previous piece projects as a `tool` message with no call, which providers
 * reject (the same hazard `selectShadowableRange`'s walk-off exists for). The
 * piece boundaries come from the SHARED fold — `deriveMessagesUpTo` twice, tail
 * taken — so a piece can never show a different projection than the main path.
 *
 * A piece whose SINGLE block exceeds the budget is emitted alone and over
 * budget: there is nothing to split further, and the caller's fail-soft path
 * already covers the case where even that does not fit.
 *
 * M75 fix round (R2): the block unit is a TURN. A cut candidate is the position
 * immediately before a `turn/start` (or, for a session carrying no `turn/start`
 * at all, before a `user/message`), then walked off tool events by the SAME rule
 * the two existing boundary sites use (`walkOffToolEvents`) — so each piece
 * reads on its own. An earlier draft cut per tool call and measured pieces of
 * `assistant(toolCalls) + tool` with no user message at all (review finding I2).
 *
 * M75 fix round (R3): the walk discards and restarts across a fold
 * discontinuity — see the loop below.
 */
export function sliceRegion(session: Session, shadowedSeqs: number[], budgetTokens: number): LLMMessage[][] {
  const inRegion = new Set(shadowedSeqs)
  const events = session.events
  const seqOf = (i: number): number => events[i]!.seq ?? i
  const isToolEvent = (i: number): boolean => events[i]!.type === "tool/call" || events[i]!.type === "tool/result"

  // The region's first and last events bound the walk, so the pieces tile
  // exactly the fold the single-call path replays — `deriveMessagesUpTo` over
  // the region's last seq (see `compactOnce`'s prefix).
  let first = -1
  let last = -1
  for (let i = 0; i < events.length; i++) {
    const seq = events[i]!.seq
    if (seq === undefined || !inRegion.has(seq)) continue
    if (first < 0) first = i
    last = i
  }
  if (first < 0) return []

  // Cut candidates: the position immediately before a `turn/start` (the unit a
  // piece reads on its own), or before a `user/message` when the session has no
  // `turn/start` anywhere. The walk-off starts one event BEFORE the candidate:
  // a `turn/start` can land inside an open tool block (an aborted turn) and a
  // mid-block `user/message` reminder is a real shape in this tree, so the cut
  // moves back to just after the first non-tool event and the whole tool run
  // goes to the new piece.
  const cutEvent = events.some((e) => e.type === "turn/start") ? "turn/start" : "user/message"
  const bounds: number[] = [first]
  for (let i = first + 1; i <= last; i++) {
    const ev = events[i]!
    if (ev.type !== cutEvent) continue
    if (ev.seq === undefined || !inRegion.has(ev.seq)) continue
    const j = walkOffToolEvents(session, i - 1)
    // A walk that bottoms out on a tool event means the run reaches index 0:
    // there is then no boundary inside the run to cut at.
    if (isToolEvent(j)) continue
    const boundary = j + 1
    if (boundary > bounds[bounds.length - 1]! && boundary <= last) bounds.push(boundary)
  }

  // Each block ends where the next one begins; the final block ends at the
  // region's last event, which is what makes the pieces tile that fold.
  const blockEnds: number[] = []
  for (let k = 0; k + 1 < bounds.length; k++) blockEnds.push(seqOf(bounds[k + 1]! - 1))
  blockEnds.push(seqOf(last))

  // Price each block as the fold's TAIL beyond the previous block's fold (the
  // projection is never re-implemented), then close a slice before any block
  // that would push it over the budget — a block that alone exceeds it stays a
  // slice of its own, because there is nothing left to split.
  const slices: LLMMessage[][] = []
  let current: LLMMessage[] = []
  let currentTokens = 0
  let prefixLen = 0
  for (const end of blockEnds) {
    const fold = deriveMessagesUpTo(session, end)
    // R3: `deriveMessagesUpTo` is NOT monotone in `maxSeq` — a rewrite marker
    // (`compaction/summary`, `compaction/reset`, `rewind/point`) inside the
    // region elides its seqs as soon as the fold crosses it, so the fold
    // SHRINKS. What has been accumulated describes a projection that is no
    // longer the one the single call would send: discard it and restart the
    // walk here, so the pieces tile `deriveMessagesUpTo(session, last)` — the
    // required invariant, because that fold is what the single-call path
    // replays. The discarded messages are exactly the ones the projection no
    // longer shows.
    if (fold.length < prefixLen) {
      slices.length = 0
      current = []
      currentTokens = 0
      prefixLen = 0
    }
    const block = fold.slice(prefixLen)
    prefixLen = fold.length
    if (block.length === 0) continue
    const price = estimateContent(block)
    if (current.length > 0 && currentTokens + price > budgetTokens) {
      slices.push(current)
      current = []
      currentTokens = 0
    }
    current.push(...block)
    currentTokens += price
  }
  if (current.length > 0) slices.push(current)
  return slices
}
