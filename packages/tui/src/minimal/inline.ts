// M38a G1: the Inline (insert_before) forward engine for minimal mode.
//
// Owns the live region grid (RegionLine canon) and the NATIVE-scrollback
// commit semantics: commit() appends lines ABOVE the bottom-pinned live region,
// in the terminal's own buffer (scrollback + screen), without ever re-emitting
// committed text (print-once). drawRegion() repaints ONLY the region rows.
//
// ESCAPE-SEQUENCE SCHEME (the goldens in test/inline.test.ts pin these bytes):
//
//   commit(k lines) =
//     { for i in 0..k-1: paintRow(regionTop + i, line[i]) }     // CUP + runs + EL
//     + CUP(rows, 1) + "\n" × k                                  // whole-screen scroll up k
//     + drawRegion()                                             // region re-draw at the bottom
//
// Rationale (source: the reference implementation's own insert_before writer):
//   - ratatui's `Terminal.insert_before` (xai-ratatui-inline/src/terminal.rs:
//     `insert_before_no_scrolling_regions`, lines 905-993) implements
//     "insert before the inline viewport" with NO DECSTBM: it scrolls the
//     whole screen up and paints the new lines into the freed gap. Its
//     `scroll_up` helper (lines 1122-1132) is precisely:
//       set_cursor_position(0, last_known_area.height - 1)  // bottom-left
//       backend.append_lines(lines)                          // whole-screen scroll up
//     i.e. cursor at the BOTTOM row, then a whole-screen scroll up by k —
//     the "whole-screen margins" of the design spec (no DECSTBM margins are
//     ever set, so the default full-screen margin applies; that is what makes
//     the scroll tmux/Zellij-safe — the degradation notes are about DECSTBM
//     scroll regions, which this engine never emits).
//   - The pager builds WITHOUT the `scrolling-regions` feature (see
//     xai-grok-pager-minimal/src/live.rs:884 "The pager builds without the
//     `scrolling-regions` feature; that variant is a separate
//     (unused-by-the-pager) path"), so the reference uses that cursor-to-bottom
//     + whole-screen scroll, exactly the shape mirrored here.
//   - Scroll primitive: this engine spells the whole-screen scroll-up as
//     LF-at-the-bottom-row ("\n" × k) rather than CSI S (`\x1b[{n}S`).
//     Both are the same terminal operation on real terminals (whole-margin
//     scroll-up, top line into native scrollback). Empirical validation on
//     @xterm/headless 6.0.0 (the test oracle) showed WHY LF is load-bearing:
//     the oracle's CSI S handler (`InputHandler.scrollUp`) splices the top
//     line out of the buffer — content is dropped, `baseY` never grows, so
//     committed lines never become observable "scrollback". The LF path goes
//     through the lineFeed scroll (`BufferService.scroll`): `baseY` grows by
//     one per LF and the scrolled-off line is PRESERVED in the native buffer
//     (length/rows and getLine(y<baseY) verification below). Real terminals
//     (xterm/VTE/ConPTY) preserve on CSI S as well; adopting LF makes the
//     oracle and the real terminal agree, and keeps the sequence free of
//     DECSTBM / CSI T / alt-screen entirely.
//
// Repeated commits accumulate: the terminal's own buffer is
// [previous content] + [committed lines, in chronological order] +
// [region at the bottom]. On a cold start the above-region area is blank, so
// the first committed lines sit ON SCREEN (directly above the region) and the
// scrolled-off top rows are blank lines; once the above-region area fills,
// the earliest committed lines land in y<baseY native scrollback in order
// (same as any terminal's native scrolling + the reference's documented
// insert_before behavior: "If more lines are inserted than there is space on
// the screen, then the top lines will go directly into the terminal's
// scrollback buffer" — xai-ratatui-inline/src/terminal.rs:786-787).

import type { InlineLiveRegion, InlineMetrics, RegionLine } from "./contracts.ts"
import type { StyledRun, TextStyle } from "../contracts.ts"
import { wcwidth } from "@i-harness/tui-core"

/** Compact style map: semantic TextStyle → inline SGR. tui-core's ansi style
 * machine (ansi/style.ts) is NOT part of the exported surface, so a minimal
 * named-ANSI-16 map lives here (matching the reference's "terminal-native
 * colors only" policy for minimal mode — the committed_renderer
 * `with_flat_background`/native-color lock in commit.rs). */
const SGR: Record<TextStyle, string> = {
  "text": "",
  "muted": "\x1b[2m",
  "dim": "\x1b[2m",
  "bold": "\x1b[1m",
  "accent-user": "\x1b[36m",
  "accent-assistant": "\x1b[32m",
  "accent-system": "\x1b[33m",
  "accent-error": "\x1b[31m",
  "accent-success": "\x1b[32m",
  "accent-plan": "\x1b[34m",
  "accent-model": "\x1b[35m",
  "warning": "\x1b[33m",
  "md-code": "\x1b[36m",
  "md-heading": "\x1b[1m",
  "md-muted": "\x1b[2m",
  "diff-add": "\x1b[32m",
  "diff-del": "\x1b[31m",
  "link": "\x1b[4m",
}

/** Region height policy: default min(10, max(3, rows-2)); degenerate rows<5 → 2. */
export function regionRowsFor(rows: number): number {
  if (rows < 5) return 2
  return Math.min(10, Math.max(3, rows - 2))
}

/** Longest cluster-safe prefix of `text` that fits `cols` columns. A width-2
 * grapheme at the LAST column is skipped (dropped) — terminals cannot host it
 * there; a grapheme that would start past the right edge stops the line.
 * G2 pre-wraps, so in normal flow the whole line fits; this guard makes the
 * engine safe for malformed input and pins the right-edge golden.
 * Control characters (newlines, tabs) are dropped (wcwidth 0) — a RegionLine
 * is one display row. */
function isControl(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  return cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)
}

export function fitGraphemes(text: string, cols: number): string {
  const cps = Array.from(text)
  let out = ""
  let col = 0
  let i = 0
  while (i < cps.length) {
    if (wcwidth(cps[i]) === 0) {
      i++
      continue // leading control / stray combining mark: drop
    }
    // Grapheme cluster = base + trailing zero-width combining marks/ZWJ.
    // Controls (tab, LF) are NOT part of a cluster — they are dropped.
    let g = cps[i]
    let j = i + 1
    while (j < cps.length && wcwidth(cps[j]) === 0 && !isControl(cps[j])) {
      g += cps[j]
      j++
    }
    i = j
    const w = wcwidth(g) === 0 ? 1 : wcwidth(g)
    if (col + w > cols) break // past the right edge: clip
    if (col === cols - 1 && w === 2) break // width-2 at the last col: skip
    out += g
    col += w
  }
  return out
}

/** Merge adjacent runs with the same style (keeps emission minimal). */
function mergeRuns(runs: StyledRun[]): StyledRun[] {
  const out: StyledRun[] = []
  for (const r of runs) {
    if (r.text === "") continue
    const last = out[out.length - 1]
    if (last !== undefined && last.style === r.style) {
      last.text += r.text
    } else {
      out.push({ text: r.text, style: r.style })
    }
  }
  return out
}

/** One row: CUP(1-based row) + SGR reset + run text (intra-row reset on style
 * change) + EL (`\x1b[K`) end-of-line pad. Deterministic bytes — goldens.
 * The leading reset makes every row robust against ANY ambient SGR state;
 * a non-default final run style is reset by the next row's leading reset. */
function paintRow(y1: number, line: RegionLine | undefined, cols: number): string {
  let parts = ""
  let prevSgr = ""
  for (const r of mergeRuns(line?.runs ?? [])) {
    const sgr = SGR[r.style]
    if (sgr !== prevSgr) {
      if (prevSgr !== "") parts += "\x1b[0m"
      if (sgr !== "") parts += sgr
      prevSgr = sgr
    }
    parts += fitGraphemes(r.text, cols)
  }
  return `\x1b[${y1};1H\x1b[0m${parts}\x1b[K`
}

// ------------------------------------------------------------------ engine

export class InlineLiveRegionImpl implements InlineLiveRegion {
  private cols: number
  private rows: number
  private grid: RegionLine[]

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows > 0 ? rows : 1
    this.grid = this.padTo([], this.regionRowsForNow()) // fresh region: empty rows
  }

  /** Region top (0-based screen row). */
  private regionTop(): number {
    return this.rows - this.regionRowsForNow()
  }

  private regionRowsForNow(): number {
    return regionRowsFor(this.rows)
  }

  /** Clip to at most `rr` lines keeping the LAST lines (bottom-anchored). */
  private clipToRr(g: RegionLine[]): RegionLine[] {
    const rr = this.regionRowsForNow()
    if (g.length > rr) return g.slice(g.length - rr)
    return g
  }

  /** Pad at the TOP to exactly `rr` lines (empty rows hang from the top). */
  private padTo(g: RegionLine[], rr: number): RegionLine[] {
    if (g.length >= rr) return g.slice(g.length - rr)
    const pad: RegionLine[] = []
    for (let i = 0; i < rr - g.length; i++) pad.push({ runs: [] })
    return pad.concat(g)
  }

  /** Region canon: LAST `regionRows` lines win (bottom-anchored clip). */
  setRegionLines(lines: RegionLine[]): void {
    this.grid = this.padTo(lines, this.regionRowsForNow())
  }

  commit(lines: RegionLine[], write: (bytes: string) => void): void {
    if (lines.length === 0 || this.cols === 0) return
    const top = this.regionTop()
    let out = ""
    for (let i = 0; i < lines.length; i++) {
      out += paintRow(top + i + 1, lines[i], this.cols)
    }
    // Whole-screen scroll-up by k, native-scrollback preserving:
    // cursor to the bottom-left, then k line feeds.
    out += `\x1b[${this.rows};1H`
    for (let i = 0; i < lines.length; i++) out += "\n"
    write(out + this.drawRegionBytes())
  }

  drawRegion(write: (bytes: string) => void): void {
    write(this.drawRegionBytes())
  }

  private drawRegionBytes(): string {
    const top = this.regionTop()
    let out = ""
    for (let i = 0; i < this.grid.length; i++) {
      out += paintRow(top + i + 1, this.grid[i], this.cols)
    }
    return out
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    // Clip the canon against the NEW height first (bottom-anchored: keep the
    // LAST lines), then store the geometry; growth pads empties at the top.
    const rr = regionRowsFor(rows)
    this.grid = this.padTo(this.clipToRr(this.grid), rr)
    this.rows = rows > 0 ? rows : 1
    this.grid = this.padTo(this.clipToRr(this.grid), this.regionRowsForNow())
  }

  regionRows(): number {
    return this.regionRowsForNow()
  }

  regionLines(): RegionLine[] {
    return this.grid.map((l) => ({
      runs: l.runs.map((r) => ({ text: r.text, style: r.style })),
      ...(l.glyph !== undefined ? { glyph: l.glyph } : {}),
    }))
  }

  metrics(): InlineMetrics {
    return { cols: this.cols, rows: this.rows, regionRows: this.regionRows() }
  }
}

export function createInlineLiveRegion(cols: number, rows: number): InlineLiveRegion {
  return new InlineLiveRegionImpl(cols, rows)
}
