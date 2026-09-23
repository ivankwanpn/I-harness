import { deriveMessagesUpTo, type Session, type SessionEvent } from "@i-harness/core-session"
import type { LLMMessage } from "@i-harness/llm-seam"
import { estimateContent } from "@i-harness/token-meter"

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
 */
export function sliceRegion(session: Session, shadowedSeqs: number[], budgetTokens: number): LLMMessage[][] {
  // The region's events, in LOG order — the caller's list names the member seqs
  // (it skips compaction markers), but only the log orders them.
  const inRegion = new Set(shadowedSeqs)
  const events: { ev: SessionEvent; seq: number }[] = []
  for (const ev of session.events) {
    const seq = ev.seq
    if (seq !== undefined && inRegion.has(seq)) events.push({ ev, seq })
  }
  if (events.length === 0) return []

  // A `tool/call` whose `tool/result` still lies AHEAD in the region is what
  // makes a cut illegal (cut between the two and the piece starts with an
  // orphan). A call with no result anywhere in the region — an aborted turn
  // leaves one — pins nothing: its result can never appear, so it must not
  // freeze the boundary walk for the rest of the region.
  const resolvedAhead = new Set<string>()
  const resultsAfter = new Set<string>()
  for (let i = events.length - 1; i >= 0; i--) {
    const { ev } = events[i]!
    if (ev.type === "tool/result") resultsAfter.add(ev.callId)
    else if (ev.type === "tool/call" && resultsAfter.has(ev.callId)) resolvedAhead.add(ev.callId)
  }

  // Walk the region's BLOCKS: a `turn/start` opens one, and a `tool/call` opens
  // one when no earlier call is still waiting for a result that lies ahead.
  // Every other event extends the block it is in, so a tool block keeps each
  // call together with its result (in-between events included) and a block ends
  // exactly where the next one begins.
  const blockEnds: number[] = []
  const awaiting = new Set<string>()
  let blockEnd: number | undefined
  for (const { ev, seq } of events) {
    if (awaiting.size === 0 && (ev.type === "turn/start" || ev.type === "tool/call")) {
      if (blockEnd !== undefined) blockEnds.push(blockEnd)
    }
    blockEnd = seq
    if (ev.type === "tool/call") {
      if (resolvedAhead.has(ev.callId)) awaiting.add(ev.callId)
    } else if (ev.type === "tool/result") {
      awaiting.delete(ev.callId)
    }
  }
  if (blockEnd !== undefined) blockEnds.push(blockEnd)

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
