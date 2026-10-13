import type { Session } from "../events/types.ts"

// M42 (G2): conversation rewind — the resolved hidden region derived from one
// `rewind/point` event. Spec §3: after a rewind at markerSeq, every event with
// seq in [cutFrom, markerSeq) is HIDDEN on the projection surface (cutFrom =
// the rewind's anchorSeq; markerSeq = the rewind/point event's own seq — the
// marker itself is log-only). Events with seq >= markerSeq (new turns appended
// after the rewind) are visible again unless a LATER rewind's window covers
// them.
export interface RewindCut {
  cutFrom: number // first hidden seq (inclusive) — the rewind anchor
  markerSeq: number // the rewind/point event's own seq (exclusive bound)
}

/**
 * The resolved, NON-OVERLAPPING rewind cut windows of a session, in log
 * order — or [] when the session carries no rewind/point events (the
 * zero-change path, identical to the surface a pre-M42 reader derives).
 *
 * Composition (multiple rewinds): each rewind/point contributes a raw window
 * [anchorSeq, seq). Windows whose intervals OVERLAP meld into one union window
 * (from the earliest anchor to the latest marker — the later rewinds reach
 * back into / past an earlier hidden era, so the union is the conservative,
 * monotone projection any single skip predicate must satisfy). Windows never
 * overlap in the resolved view; the skip rule is `cutFrom <= seq < markerSeq`
 * per window.
 *
 * Defensive (Ruling 7): a malformed persisted rewind/point without a numeric
 * `seq` or `anchorSeq` contributes no window (cannot be keyed — same rule as
 * compaction/reset: unsealed events are NEVER hidden); `anchorSeq >= seq`
 * (empty window) also contributes nothing.
 */
export function rewindCuts(session: Session): RewindCut[] {
  const resolved: RewindCut[] = []
  for (const ev of session.events) {
    if (ev.type !== "rewind/point") continue
    // defensive (Ruling 7): malformed persisted logs bypass append validation
    if (typeof ev.seq !== "number" || typeof ev.anchorSeq !== "number") continue
    if (ev.anchorSeq >= ev.seq) continue // empty window — nothing to hide
    meldRewindCut(resolved, ev.anchorSeq, ev.seq)
  }
  return resolved
}

// M42: append one raw rewind window to a resolved, non-overlapping cut list.
// Events stream in log order, so markers are monotonic; a window opening at
// or before a previous window's end overlaps it → meld into the union window
// (monotone skip predicate: any seq hidden by EITHER rewind stays hidden —
// the later rewind reaches back into / past an earlier hidden era).
export function meldRewindCut(resolved: RewindCut[], cutFrom: number, markerSeq: number): void {
  const last = resolved[resolved.length - 1]
  if (last !== undefined && cutFrom < last.markerSeq) {
    if (cutFrom < last.cutFrom) last.cutFrom = cutFrom
    if (markerSeq > last.markerSeq) last.markerSeq = markerSeq
  } else {
    resolved.push({ cutFrom, markerSeq })
  }
}
