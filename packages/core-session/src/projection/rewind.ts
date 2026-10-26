import type { SessionView as Session } from "../managed/types.ts"

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
export interface OriginalWindow extends RewindCut { markerIndex: number; startRank: number; endRank: number }
function originalPoints(session: Session) {
  const result: (RewindCut & { markerIndex: number })[] = []
  for (const [markerIndex, event] of session.events.entries()) {
    if (event.type !== 'rewind/point' || typeof event.seq !== 'number' || typeof event.anchorSeq !== 'number' || event.anchorSeq >= event.seq) continue
    result.push({ cutFrom: event.anchorSeq, markerSeq: event.seq, markerIndex })
  }
  return result
}
export function originalRewindWindows(session: Session): OriginalWindow[] {
  const points = originalPoints(session)
  if (!points.length) return []
  const seqs = session.events.flatMap(event => typeof event.seq === 'number' && !Number.isNaN(event.seq) ? [event.seq] : []).sort((a, b) => a - b)
  const rank = (boundary: number) => {
    let first = 0, last = seqs.length
    while (first < last) { const middle = first + Math.floor((last - first) / 2); if (seqs[middle]! < boundary) first = middle + 1; else last = middle }
    return first
  }
  return points.map(point => ({ ...point, startRank: rank(point.cutFrom), endRank: rank(point.markerSeq) }))
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
  for (const window of originalPoints(session)) meldRewindCut(resolved, window.cutFrom, window.markerSeq)
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
