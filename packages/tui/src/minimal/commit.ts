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
   * cursor. Line-count shrink (folding) clamps — committed content is never
   * unwritten (the print-once red line). */
  pendingDelta(): RegionLine[] {
    const total = this.engine.lineCount()
    const start = Math.min(this.cursor, total)
    const height = Math.max(0, total - start)
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
   * 30fps pump; when true, flush via pendingDelta()+commitDelta. */
  idleFlushDue(now: number): boolean {
    if (this.engine.lineCount() <= this.cursor) return false
    return now - this.lastActivityAt >= this.flushMs
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
