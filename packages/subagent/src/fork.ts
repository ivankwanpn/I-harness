import type { SessionEvent } from "@i-harness/core-session"
import { remapSeedEvent } from "@i-harness/session-persistence"

/** The last N parent turns as a child's SEED — in the CHILD's coordinates.
 *
 * M74: this used to return a raw slice, so a parent's compaction markers
 * carried the parent's seq numbers into a log that starts at 0. With "all" the
 * indices coincide; with N they name unrelated events, and a summary's
 * `shadowedSeqs` would hide the child's own turn (itself included) — silent
 * content loss with no test covering it. The remap is the SAME one the session
 * fork has always applied (session-persistence's `remapSeedEvent`): renumber to
 * the child's coordinates, and drop references into events this child never
 * received. `append` only rewrites an event's own `seq`, never the seqs it
 * NAMES — which is exactly why this pass has to exist here.
 *
 * M76: `anchorSeq` WAS the one reference out of that contract — the fallthrough
 * rewrote `seq` and left the anchor in the PARENT's coordinates, so a seed
 * carrying a rewind marker located its cut window wrongly, and the error
 * direction was UNDER-hiding: the stale anchor is never below the child-side one,
 * the window `rewindCuts` resolves is a subset of the correct one, and part or
 * all of the rewound region could stay VISIBLE in the child (when the anchor
 * lands at or past the marker's child-side seq, `rewindCuts` drops the window
 * entirely — `anchorSeq >= seq`). It is the same KIND of reference the three
 * above are — it names a seq — so it now rides the same map. One boundary is
 * worth naming: an anchor this seed never received (the slice begins INSIDE the
 * window the marker opened, so nothing on this side can be its target) opens the
 * window on the child's FIRST event — everything this child owns before the
 * marker was hidden on the parent's surface, and a stale parent coordinate would
 * instead name an unrelated event here.
 *
 * The session fork resolves the same marker the other way, and still does: it
 * DROPS rewind markers (packages/session-persistence/src/fork.ts:115-120, filter
 * at :150-152), because its child never had the rewound turns at all — copying a
 * marker there would assert a window over a region that log does not contain.
 * This path keeps it (the slice is a contiguous tail of the parent's log, so the
 * events it hides can be in it), which is why the reference has to MOVE here
 * rather than vanish. */
export function forkTurns(events: SessionEvent[], n: number): SessionEvent[] {
  const seed = sliceTurns(events, n)
  // Every return path goes through the remap, including the untouched ones: for
  // a POSITIONAL whole-log seed (seq === index, what `append` writes) it is the
  // identity, and making it unconditional is what keeps the contract ("the output
  // is in child coordinates") true for all of them — a non-positional log (M51,
  // `repair.test.ts:289-302`: seqs [0, 20]) legitimately re-indexes instead.
  const renumbered = new Map<number, number>()
  for (const [index, event] of seed.entries()) {
    if (event.seq !== undefined) renumbered.set(event.seq, index)
  }
  return seed.map((event, index) => remapSeedEvent(event, index, renumbered))
}

function sliceTurns(events: SessionEvent[], n: number): SessionEvent[] {
  if (n === 0) return []
  const turnStarts: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.type === "turn/start") turnStarts.push(i)
  }
  if (turnStarts.length === 0) return events
  if (turnStarts.length <= n) return events
  return events.slice(turnStarts[turnStarts.length - n]!)
}
