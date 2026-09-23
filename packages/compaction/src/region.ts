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

/** M5/D2 — the walk-off rule the two compaction boundary sites SHARE (this
 * file's `selectShadowableRange`, `index.ts`'s `resetWindowOnce`). A cut at an
 * EVENT index discards everything before it, while `deriveMessages` folds
 * `assistant(toolCalls)` together with its `tool(result)` messages — so a cut
 * counting events can sit between the two and keep a result whose call was just
 * cut away. llm-anthropic renders that as a tool_result block with no tool_use,
 * and mid-block user messages (M52/L3 reminders) are the same hazard one event
 * later. This returns the largest cut at or below `index` that separates no
 * call/result pair; it only ever walks BACKWARDS (retaining more, never less)
 * and stops at 0 whatever sits there.
 *
 * M76: the rule is EXACT, not the heuristic it used to be. A cut `j` is safe
 * iff every `tool/result` at index >= `j` still has its `tool/call` at index
 * >= `j` — its call being the nearest PRECEDING `tool/call` with the same
 * callId, the block's own opener. The old predicate asked whether the event AT
 * the cut was a `tool/call`/`tool/result` and knew only those two names, so
 * M70's `tool/dispatch` — which sits BETWEEN a call and its result in the
 * shipped log order (`packages/core-session/src/index.ts:23`) — ended the walk
 * early and left the cut ON the result. Measured on an 8-turn read session in
 * that order (9 events per turn, results `body <t> ` x 80, 72 events): 115 of
 * 200 sampled
 * `selectShadowableRange` budgets (10..2000 step 10) and 6 of `retainLast`
 * 1..25 were orphaned, and the walk fixed NONE of them — the guard was inert
 * on the logs the tree actually writes. Nothing needs to name `tool/dispatch`
 * now: the condition is stated over the RESULTS at index >= `j`, and the
 * dispatch between a call and its result is retained or dropped with them.
 *
 * The condition asks the RESULT side, and that is load-bearing. A `tool/call`
 * that never receives a result (an aborted turn) does not exist on the
 * projection at all — `deriveMessages` drops the un-flushed pending call. A
 * call-side predicate ("is any call still open?") would judge every cut of such
 * a session unsafe, walk to 0, and leave `resetWindowOnce` with no
 * `removedSeqs` forever: the ladder's second layer degenerating to fail-closed.
 * The rule must agree with the projection, not with the intuition.
 *
 * The same asymmetry decides the one remaining case: a result whose call
 * appears NOWHERE earlier in the log (a malformed persisted log — append
 * validation does not run on resume) imposes no constraint, because the cut did
 * not separate that pair and no cut can repair it. Letting it count would drag
 * every cut to 0 — the very degeneration the result side exists to avoid. Such
 * a log is already named broken by the M5/D2 well-formedness contract
 * (`assertWellFormed`, `packages/compaction/test/engine.test.ts:314`); the walk
 * is not its repair.
 *
 * The SLICER does not call this (M75 ruling 11): it cuts in MESSAGE space and
 * carries the outstanding call ids itself from the fold it pieces up, so this
 * event-level rule — including the `tool/dispatch` blindness that made it
 * insufficient there — is not the guard on that path.
 */
export function walkOffToolEvents(session: Session, index: number): number {
  const events = session.events
  const n = events.length
  // A cut is only ever taken at an event position: clamp rather than throw on a
  // caller that asks about the (empty) tail past the end.
  let j = Math.max(0, Math.min(index, n))
  // `openCall` is the smallest call index among the results the current cut
  // KEEPS (the results at index >= j). The cut is unsafe exactly while that
  // index is itself below the cut — while a kept result lost its call. Seeded
  // with the range the unmoved cut keeps, then extended one event at a time as
  // the walk moves back; the walk ends on the first safe cut it reaches, so the
  // result is the largest safe cut at or below `index`.
  let openCall = Number.POSITIVE_INFINITY
  for (let k = j; k < n; k++) {
    const ev = events[k]!
    if (ev.type !== "tool/result") continue
    const call = callIndexOf(events, k, ev.callId)
    if (call < openCall) openCall = call
  }
  while (j > 0 && openCall < j) {
    j -= 1
    const ev = events[j]!
    if (ev.type !== "tool/result") continue
    const call = callIndexOf(events, j, ev.callId)
    if (call < openCall) openCall = call
  }
  return j
}

/** The index of the `tool/call` a `tool/result` at `at` belongs to: the nearest
 * PRECEDING call with the same callId (the block's own opener — the one
 * `deriveMessages` folds it with). `POSITIVE_INFINITY` when the log holds no
 * such call at all, so a result nothing opened constrains no cut (see the
 * walk's docstring). */
function callIndexOf(events: SessionEvent[], at: number, callId: string): number {
  for (let i = at - 1; i >= 0; i--) {
    const ev = events[i]!
    if (ev.type === "tool/call" && ev.callId === callId) return i
  }
  return Number.POSITIVE_INFINITY
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
      // M5/D2: walk BACK off any tool event before cutting — `walkOffToolEvents`
      // is that rule's ONE home (this site used to inline the loop; so did
      // resetWindowOnce). Measured on a 12-turn tool session BEFORE the M76
      // exact rule: 50/150/300/900 all orphan, while 500 lands on a `tool/call`
      // and survives — by arithmetic, not by design. Those five orphan none
      // under the exact rule.
      const j = walkOffToolEvents(session, i)
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
