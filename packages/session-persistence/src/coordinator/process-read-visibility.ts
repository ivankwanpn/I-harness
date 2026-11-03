import { managedResultRefs, validManagedArtifactRef, type ManagedArtifactRef, type SessionEventView } from '@i-harness/core-session'
import { createNumericTree } from './process-read-tree.ts'

/** Original result slots and rewind semantics, incrementally indexed. */
export function createProcessReadVisibility() {
  const counts = new Map<string, number>(), postings = createNumericTree<string[]>(), coverage = createNumericTree<number>()
  const cuts: { cutFrom: number; markerSeq: number }[] = []
  const key = (ref: ManagedArtifactRef) => JSON.stringify([ref.version, ref.id, ref.revision, ref.codec, ref.encodedBytes, ref.contentDigest, ref.completeness])
  const covered = (seq: number) => { const previous = coverage.floor(seq); return previous !== undefined && seq < previous.value }
  const addCoverage = (start: number, end: number) => {
    const previous = coverage.floor(start)
    if (previous && previous.value >= start) { start = previous.key; end = Math.max(end, previous.value); coverage.delete(previous.key) }
    for (;;) { const next = coverage.lowerBound(start); if (!next || next.key > end) break; end = Math.max(end, next.value); coverage.delete(next.key) }
    coverage.set(start, end)
    for (;;) {
      const posting = postings.lowerBound(start); if (!posting || posting.key >= end) break
      postings.delete(posting.key)
      for (const refKey of posting.value) { const remaining = counts.get(refKey)! - 1; if (remaining) counts.set(refKey, remaining); else counts.delete(refKey) }
    }
  }
  return {
    add(events: readonly SessionEventView[]) {
      for (const event of events) {
        const seq = event.seq
        if (seq !== undefined && (typeof seq !== 'number' || !Number.isFinite(seq))) throw new Error('PROCESS_READ_UNAVAILABLE')
        if (event.type === 'rewind/point' && typeof seq === 'number' && typeof event.anchorSeq === 'number') {
          if (!Number.isFinite(event.anchorSeq)) throw new Error('PROCESS_READ_UNAVAILABLE')
          if (event.anchorSeq < seq) {
            const last = cuts.at(-1)
            if (last && event.anchorSeq < last.markerSeq) { last.cutFrom = Math.min(last.cutFrom, event.anchorSeq); last.markerSeq = Math.max(last.markerSeq, seq); addCoverage(last.cutFrom, last.markerSeq) }
            else { cuts.push({ cutFrom: event.anchorSeq, markerSeq: seq }); addCoverage(event.anchorSeq, seq) }
          }
        }
        for (const ref of managedResultRefs(event)) {
          if (!validManagedArtifactRef(ref)) throw new Error('PROCESS_READ_UNAVAILABLE')
          if (seq !== undefined && covered(seq)) continue
          const refKey = key(ref); counts.set(refKey, (counts.get(refKey) ?? 0) + 1)
          if (seq !== undefined) { const bucket = postings.get(seq); if (bucket) bucket.push(refKey); else postings.set(seq, [refKey]) }
        }
      }
    },
    contains(ref: ManagedArtifactRef) { return validManagedArtifactRef(ref) && (counts.get(key(ref)) ?? 0) > 0 },
  }
}
