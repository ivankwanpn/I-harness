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
 * NAMES — which is exactly why this pass has to exist here. */
export function forkTurns(events: SessionEvent[], n: number): SessionEvent[] {
  const seed = sliceTurns(events, n)
  // Every return path goes through the remap, including the untouched ones: for
  // a whole-log seed it is the identity, and making it unconditional is what
  // keeps the contract ("the output is in child coordinates") true for all of them.
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
