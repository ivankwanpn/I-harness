// @i-harness/tui — G2: minimal-mode print-once commit pipeline (M38a).
// MinimalCommits owns the committed-cursor over the ScrollbackEngine display
// rows: what the loop already pushed into the live region's scrollback vs.
// what the engine now holds (the delta). Boundaries decide WHEN to commit:
// turn/end, compaction/*, and user/system (they CLOSE the open assistant
// block — the "assistant block closed" trigger) — plus a 500ms idle flush
// for long streams (an assistant text that never closes a block; the loop
// ticks idleFlushDue from its animation pump, spec §0 print-once).

import type { DisplayLine, TuiEvent } from "../contracts.ts"
import type { RegionLine } from "./contracts.ts"

/** The viewport surface MinimalCommits reads — the ScrollbackEngine slice. */
export interface CommitEngine {
  viewport(offset: number, height: number): DisplayLine[]
  lineCount(): number
  /** M52 L1: cumulative NET rows removed by retain()'s FRONT trim (OPTIONAL —
   * engines without the member never shrink that way). */
  trimmedLines?(): number
}

export interface CommitOptions {
  /** Test clock — defaults to Date.now(). */
  now?: () => number
  /** Idle tail-flush threshold in ms (default 500). */
  flushMs?: number
}

/** DisplayLine → RegionLine passthrough: semantic runs verbatim + the
 * engine-resolved glyph; timestamps/metadata are scrollback-only. */
export function displayToRegion(line: DisplayLine): RegionLine {
  return { runs: line.runs, glyph: line.glyph }
}

/**
 * The committed-cursor pipeline. Every row is emitted exactly once (print-
 * once): `pendingDelta()` returns the rows the engine grew since the last
 * commit (from the cursor to lineCount) and advances the cursor.
 */
export class MinimalCommits {
  private cursor = 0
  /** M52 L1: last engine trim count folded into `cursor`. */
  private seenTrimmedLines = 0
  private lastActivityAt = -Infinity
  private readonly now: () => number
  private readonly flushMs: number

  constructor(
    private readonly engine: CommitEngine,
    opts: CommitOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now())
    this.flushMs = opts.flushMs ?? 500
  }

  /** Rows NOT yet committed (engine cursor → lineCount); advances the
   * cursor. A retain shrink is folded in FIRST (front trim ⇒ cursor shifts by
   * the trimmed rows); any remaining line-count shrink (rewind) re-anchors the
   * cursor DOWN to the new total so the next delta starts at the engine's
   * first new row — never reset to 0, which would re-emit committed content
   * (print-once). */
  pendingDelta(): RegionLine[] {
    const total = this.syncTrim()
    if (total < this.cursor) this.cursor = total // shrink (rewind)
    const start = this.cursor
    const height = total - start
    if (height <= 0) return []
    this.cursor = total
    return this.engine.viewport(start, height).map(displayToRegion)
  }

  /** True = a commit is due for this event:
   * - turn/end (the turn is complete)
   * - compaction start AND end (boundary — the compacted summary lands)
   * - user / user/edit / system (they close the open assistant block)
   * Streaming rows (assistant/thinking/tool chunks, todo/status bookkeeping)
   * return false — they flush at a boundary or after the idle threshold. */
  onEvent(ev: TuiEvent): boolean {
    this.lastActivityAt = this.now()
    switch (ev.type) {
      case "turn": return ev.phase === "end"
      case "compaction": return true
      case "user":
      case "user/edit":
      case "system": return true
      default: return false
    }
  }

  /** Idle tail-flush: an uncommitted delta older than the threshold (a long
   * assistant stream with no block close). The loop ticks this from its
   * 30fps pump; when true, flush via pendingDelta()+commitDelta. A shrink is
   * re-anchored here too (the pump is the only observer between boundaries —
   * waiting for pendingDelta would miss the shrink once total re-passes the
   * stale cursor, resuming mid-block). */
  idleFlushDue(now: number): boolean {
    const total = this.syncTrim()
    if (total < this.cursor) this.cursor = total // shrink (rewind)
    if (total <= this.cursor) return false
    return now - this.lastActivityAt >= this.flushMs
  }

  /** M52 L1: fold the engine's reported FRONT-trim into the cursor. retain
   * removes LEADING rows, so the cursor (an index into display rows) shifts
   * down by exactly the removed rows — an uncommitted tail keeps its identity
   * and still commits. The marker row (new row 0) counts as committed once
   * anything was, so it is never emitted (print-once, M51 T1 invariant). A
   * rewind shrink reports nothing here and still re-anchors to the total. */
  private syncTrim(): number {
    const trimmed = this.engine.trimmedLines?.() ?? 0
    if (trimmed > this.seenTrimmedLines) {
      const shift = trimmed - this.seenTrimmedLines
      this.seenTrimmedLines = trimmed
      this.cursor = this.cursor === 0 ? 0 : Math.max(1, this.cursor - shift)
    }
    return this.engine.lineCount()
  }
}

/** The commit sink — G1's InlineLiveRegion.commit(lines, write). */
export interface CommitWriter {
  commit(lines: RegionLine[], write: (s: string) => void): void
}

/** Push a resolved delta into the live region — print-once: the writer
 * appends into the NATIVE terminal scrollback and re-places the region
 * below it. All bytes flow through `write` (the app sink → ledger). */
export function commitDelta(
  writer: CommitWriter,
  delta: RegionLine[],
  write: (s: string) => void,
): void {
  if (delta.length === 0) return
  writer.commit(delta, write)
}
