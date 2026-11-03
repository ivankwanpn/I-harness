import type { SessionView as Session } from "../managed/types.ts"

/** M5/D3: the three markers that share the shadow mechanism (see the pre-pass
 * inside deriveMessages). A rewrite of the model-visible projection is possible
 * ONLY through one of these, which is what makes it derivable. */
type ProjectionRewriteCause = "compaction/summary" | "compaction/reset" | "rewind" | 'compaction/replacement'

export interface ProjectionRewrite {
  /** How many rewrite markers the log carries right now. A CONSUMER COMPARES
   * THIS BETWEEN REQUESTS: a bigger number than last time means a rewrite landed
   * in between, which is what breaks the cached prefix. The absolute value is
   * not a break — after one compaction it stays non-zero forever, so a boolean
   * "was this rewritten?" would report every later request as a break. */
  markers: number
  /** The kind of the most recent marker, so a break can be ATTRIBUTED rather
   * than merely noticed. Absent when there are none. */
  lastCause?: ProjectionRewriteCause
  /** Total seqs hidden by compaction markers. Rewind hides by window, so this
   * counts only what the markers name. */
  hiddenSeqs: number
}

export function deriveProjectionRewrite(session: Session): ProjectionRewrite {
  const index=createProjectionRewriteIndex();index.stage(session.events).commit();return index.read()
}
/** Same original rewrite arithmetic without retaining marker payloads. */
export function createProjectionRewriteIndex(){
 let current:ProjectionRewrite={markers:0,hiddenSeqs:0},revision=0
 return {read:()=>({...current}),stage(events:readonly import('../managed/types.ts').SessionEventView[]){
  const expected=revision;let {markers,hiddenSeqs,lastCause}=current,installed=false
  for (const ev of events) {
    if (ev.type === 'compaction/replacement') {
      markers++
      lastCause = 'compaction/replacement'
      hiddenSeqs += new Set(ev.coverage.flatMap(entry => entry.sources.map(source => source.seq))).size
    } else if (ev.type === "compaction/summary") {
      markers += 1
      lastCause = "compaction/summary"
      hiddenSeqs += ev.shadowedSeqs.length
    } else if (ev.type === "compaction/reset") {
      markers += 1
      lastCause = "compaction/reset"
      hiddenSeqs += (ev.removedSeqs ?? []).length
    } else if (ev.type === "rewind/point") {
      // Same defensive shape as the pre-pass: a malformed persisted marker with
      // a non-numeric or empty window contributes no cut, so it is not a rewrite.
      if (typeof ev.seq === "number" && typeof ev.anchorSeq === "number" && ev.anchorSeq < ev.seq) {
        markers += 1
        lastCause = "rewind"
      }
    }
  }
  return {commit(){if(installed)return;if(revision!==expected)throw TypeError('Stale rewrite observation');current={markers,hiddenSeqs,...lastCause!==undefined?{lastCause}:{}};revision++;installed=true}}
 }}
}
