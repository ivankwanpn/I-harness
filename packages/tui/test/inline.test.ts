// M38a G1: Inline (insert_before) forward engine — mirror-style, deterministic.
// Two-layer verification: (a) exact byte goldens of every emission surface, and
// (b) replay through the REAL VT parser (@xterm/headless 6.0.0) asserting the
// terminal's native buffer: the committed lines sit IN ORDER above the
// bottom-pinned live region (in the native scrollback tail once the
// above-region area fills), the region rows intact, print-once.
//
// Oracle facts (verified empirically, pinned by the tests below):
// - CSI S (`\x1b[1S`) in xterm 6 headless splices the top line OUT (dropped,
//   baseY never grows) — so the engine scrolls via LF-at-the-bottom-row, which
//   goes through the lineFeed scroll path: baseY grows by one per LF, the
//   scrolled-off line is preserved in the native buffer (see inline.ts header).
// - buffer.active.getLine(y) is an ABSOLUTE 0-based index into the whole buffer
//   (scrollback = [0, baseY), screen rows = [baseY, baseY + rows)).

import { describe, expect, it } from "vitest"
import type { ITerminalInitOnlyOptions, ITerminalOptions, IBufferCell, Terminal as XTerminal } from "@xterm/headless"
import { createInlineLiveRegion, InlineLiveRegionImpl, regionRowsFor, fitGraphemes } from "../src/minimal/inline.ts"
import type { RegionLine } from "../src/minimal/contracts.ts"

// ------------------------------------------------------------------ harness

// @xterm/headless is CJS (webpack UMD) — resolve the ctor for both shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const XtermImpl = (await import("@xterm/headless")) as any
const TerminalCtor = (XtermImpl.Terminal ?? XtermImpl.default?.Terminal) as
  | (new (o: ITerminalOptions & ITerminalInitOnlyOptions) => XTerminal)
  | undefined
if (TerminalCtor === undefined) {
  throw new Error("@xterm/headless: Terminal constructor not found")
}
const Ctor = TerminalCtor // narrowed for class-body use

/** Byte-accumulating write sink (the engine's only output channel). */
function sink(): { write: (s: string) => void; bytes(): string } {
  let bytes = ""
  return { write: (s) => void (bytes += s), bytes: () => bytes }
}

class Xterm {
  readonly term: XTerminal
  constructor(cols: number, rows: number) {
    this.term = new Ctor({ cols, rows, scrollback: 1000, allowProposedApi: true })
  }
  write(s: string): void {
    // Sequential processing is internal; drain() gates every assertion.
    void this.term.write(s)
  }
  async drain(): Promise<void> {
    // xterm processes writes sequentially on an internal queue; the callback of
    // a terminal write fires only after every queued chunk has been parsed —
    // await THAT, not the (void) return value.
    await new Promise<void>((resolve) => {
      void this.term.write("", () => resolve())
    })
  }
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }
  get rows(): number {
    return this.term.rows
  }
  /** Scrollback count: lines[0, baseY) are the native scrollback tail. */
  get baseY(): number {
    return this.term.buffer.active.baseY
  }
  get length(): number {
    return this.term.buffer.active.length
  }
  /** Absolute buffer line text (y in [0, length)). */
  line(y: number): string {
    const l = this.term.buffer.active.getLine(y)
    return l === undefined ? "" : l.translateToString(true)
  }
  /** Viewport row (0-based) text. */
  row(r: number): string {
    return this.line(this.baseY + r)
  }
  /** Head-column widths of a viewport row (0 = continuation half of width-2). */
  cellWidths(r: number): number[] {
    const out: number[] = []
    for (let x = 0; x < this.term.cols; x++) {
      const cell = this.term.buffer.active.getLine(this.baseY + r)?.getCell(x) as IBufferCell | undefined
      out.push(cell === undefined ? 1 : cell.getWidth())
    }
    return out
  }
}

// ------------------------------------------------------------------ fixtures

const COLS = 20
const ROWS = 24
const REGION_ROWS = 10

const rc = (i: number): RegionLine => ({ runs: [{ text: `rc${i}`, style: "text" }] })
const rcGrid = Array.from({ length: REGION_ROWS }, (_, i) => rc(i))
const rcTexts = Array.from({ length: REGION_ROWS }, (_, i) => `rc${i}`)

/** Golden row helper: CUP(1-based y, col 1) + leading SGR reset + body + EL. */
const gRow = (y1: number, body: string): string => `\x1b[${y1};1H\x1b[0m${body}\x1b[K`

const count = (hay: string, needle: string): number => hay.split(needle).length - 1

/** Draw the whole region once. */
function drawAll(eng: InlineLiveRegionImpl): string {
  const s = sink()
  eng.drawRegion(s.write)
  return s.bytes()
}

describe("regionRowsFor: region height policy", () => {
  it("min(10, max(3, rows-2)) with a rows<5 degenerate floor of 2", () => {
    expect(regionRowsFor(24)).toBe(10)
    expect(regionRowsFor(30)).toBe(10)
    expect(regionRowsFor(40)).toBe(10)
    expect(regionRowsFor(8)).toBe(6)
    expect(regionRowsFor(5)).toBe(3)
    expect(regionRowsFor(4)).toBe(2)
    expect(regionRowsFor(1)).toBe(2)
  })
})

describe("fitGraphemes: cluster-safe, right-edge wide-char guard", () => {
  it("clips past the right edge and skips a width-2 grapheme at the last col", () => {
    expect(fitGraphemes("x".repeat(19) + "界", 20)).toBe("x".repeat(19))
    expect(fitGraphemes("x".repeat(18) + "界", 20)).toBe("x".repeat(18) + "界")
    expect(fitGraphemes("界", 20)).toBe("界")
    expect(fitGraphemes("界", 1)).toBe("")
    expect(fitGraphemes("界", 2)).toBe("界")
  })
  it("keeps wide graphemes whole (no mid-cluster split) and drops controls", () => {
    expect(fitGraphemes("ab界cd", 20)).toBe("ab界cd")
    expect(fitGraphemes("a\tb\nc", 20)).toBe("abc")
    expect(fitGraphemes("🌲", 20)).toBe("🌲")
    expect(fitGraphemes("🌲", 1)).toBe("")
  })
})

describe("case 1: empty start drawRegion goldens", () => {
  it("emits the region rows exactly, `\\x1b[K` pads, pure empty rows", () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    const out = drawAll(eng)
    expect(out).toBe(
      gRow(15, "") + gRow(16, "") + gRow(17, "") + gRow(18, "") + gRow(19, "") +
      gRow(20, "") + gRow(21, "") + gRow(22, "") + gRow(23, "") + gRow(24, ""),
    )
    expect(out).toBe(
      "\x1b[15;1H\x1b[0m\x1b[K\x1b[16;1H\x1b[0m\x1b[K\x1b[17;1H\x1b[0m\x1b[K\x1b[18;1H\x1b[0m\x1b[K\x1b[19;1H\x1b[0m\x1b[K" +
      "\x1b[20;1H\x1b[0m\x1b[K\x1b[21;1H\x1b[0m\x1b[K\x1b[22;1H\x1b[0m\x1b[K\x1b[23;1H\x1b[0m\x1b[K\x1b[24;1H\x1b[0m\x1b[K",
    )
  })
  it("paints the region canon rows (default style: no per-run SGR in the bytes)", () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    expect(drawAll(eng)).toBe(
      gRow(15, "rc0") + gRow(16, "rc1") + gRow(17, "rc2") + gRow(18, "rc3") + gRow(19, "rc4") +
      gRow(20, "rc5") + gRow(21, "rc6") + gRow(22, "rc7") + gRow(23, "rc8") + gRow(24, "rc9"),
    )
  })
  it("replays: region occupies the bottom 10 rows; nothing above", async () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    const t = new Xterm(COLS, ROWS)
    t.write(drawAll(eng))
    await t.drain()
    expect(Array.from({ length: REGION_ROWS }, (_, i) => t.row(ROWS - REGION_ROWS + i)).join("|")).toBe(rcTexts.join("|"))
    expect(t.baseY).toBe(0)
  })
})

describe("case 2: commit one line", () => {
  it("bytes: one row at the region top + bottom-row cursor + 1 LF + region re-draw", () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    const out = sink()
    eng.commit([{ runs: [{ text: "L-one", style: "text" }] }], out.write)
    expect(out.bytes()).toBe(
      gRow(15, "L-one") + // committed line painted at the region top row
      `\x1b[${ROWS};1H` + // cursor to the bottom row (whole-screen margin base)
      "\n" + // whole-screen scroll up 1 (LF = native scrollback path)
      gRow(15, "rc0") + gRow(16, "rc1") + gRow(17, "rc2") + gRow(18, "rc3") + gRow(19, "rc4") +
      gRow(20, "rc5") + gRow(21, "rc6") + gRow(22, "rc7") + gRow(23, "rc8") + gRow(24, "rc9"),
    )
    expect(count(out.bytes(), "L-one")).toBe(1) // print-once: text emitted exactly one time
  })
  it("replay: the committed line sits directly above the region, region intact", async () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    const t = new Xterm(COLS, ROWS)
    t.write(drawAll(eng))
    const s = sink()
    eng.commit([{ runs: [{ text: "L-one", style: "text" }] }], s.write)
    t.write(s.bytes())
    await t.drain()
    // Native scrollback grew by one (the scrolled-off top row is preserved —
    // blank at cold start); the region rows are intact.
    expect(t.baseY).toBe(1)
    expect(t.length).toBe(ROWS + 1)
    const regionTop = t.length - REGION_ROWS
    expect(Array.from({ length: REGION_ROWS }, (_, i) => t.line(regionTop + i)).join("|")).toBe(rcTexts.join("|"))
    // The k committed lines are the k lines DIRECTLY above the region.
    expect(t.line(regionTop - 1)).toBe("L-one")
    expect(t.line(regionTop - 2)).toBe("") // still blank above (cold start)
  })
})

describe("case 3: three committed lines in two commits — in order, region at the bottom", () => {
  it("replay: scrollback + screen = [..., A-one, B-two, C-three] + region", async () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    const t = new Xterm(COLS, ROWS)
    t.write(drawAll(eng))
    for (const text of ["A-one", "B-two", "C-three"]) {
      const s = sink()
      eng.commit([{ runs: [{ text, style: "text" }] }], s.write)
      t.write(s.bytes())
    }
    await t.drain()
    expect(t.baseY).toBe(3)
    expect(t.length).toBe(ROWS + 3)
    const regionTop = t.length - REGION_ROWS
    expect(Array.from({ length: REGION_ROWS }, (_, i) => t.line(regionTop + i)).join("|")).toBe(rcTexts.join("|"))
    expect(t.line(regionTop - 1)).toBe("C-three")
    expect(t.line(regionTop - 2)).toBe("B-two")
    expect(t.line(regionTop - 3)).toBe("A-one")
    // earlier content (blank rows at cold start) precedes them in order
    expect(t.line(regionTop - 4)).toBe("")
  })
  it("one commit with 3 lines: same end state", async () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    const t = new Xterm(COLS, ROWS)
    t.write(drawAll(eng))
    const s = sink()
    eng.commit(["A-one", "B-two", "C-three"].map((text) => ({ runs: [{ text, style: "text" }] })), s.write)
    t.write(s.bytes())
    await t.drain()
    expect(t.baseY).toBe(3)
    const regionTop = t.length - REGION_ROWS
    expect(t.line(regionTop - 1)).toBe("C-three")
    expect(t.line(regionTop - 2)).toBe("B-two")
    expect(t.line(regionTop - 3)).toBe("A-one")
  })
})

describe("case 4: wide chars (CJK/emoji) — no mid-cluster split, right-edge guard", () => {
  it("committed wide lines survive the scroll whole (width-2 heads intact)", async () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    const t = new Xterm(COLS, ROWS)
    t.write(drawAll(eng))
    const s = sink()
    const wideLine = "🌲前边x" // 2 + 2 + 2 + 1 = 7 cols, well within 20
    eng.commit([{ runs: [{ text: wideLine, style: "text" }] }], s.write)
    t.write(s.bytes())
    await t.drain()
    const regionTop = t.length - REGION_ROWS
    expect(t.line(regionTop - 1)).toBe(wideLine) // no split, no reflow
    // The CJK wide heads are intact: width-2 heads followed by width-0
    // continuation cells, ending in the narrow `x`. (The oracle measures the
    // 🌲 emoji at width 1 — xterm.js 6's own wcwidth disagrees with tui-core's
    // width-2 emoji table — so the assertion covers the CJK pair only; the
    // emoji itself is verified intact via the line text above.)
    const widths = t.cellWidths(t.rows - REGION_ROWS - 1)
    expect(widths.slice(1, 6)).toEqual([2, 0, 2, 0, 1])
  })
  it("right-edge guard: width-2 glyph at the last column is dropped", async () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines([{ runs: [{ text: "x".repeat(19) + "界", style: "text" }] }, ...rcGrid.slice(1)])
    const out = drawAll(eng)
    // Row 15: the last column belongs to a width-2 界 → skipped (19 x's remain).
    expect(out).toBe(
      gRow(15, "x".repeat(19)) + gRow(16, "rc1") + gRow(17, "rc2") + gRow(18, "rc3") +
      gRow(19, "rc4") + gRow(20, "rc5") + gRow(21, "rc6") + gRow(22, "rc7") + gRow(23, "rc8") + gRow(24, "rc9"),
    )
    const t = new Xterm(COLS, ROWS)
    t.write(out)
    await t.drain()
    // No width-2 head at the last column; the second-to-last is a narrow cell.
    const widths = t.cellWidths(ROWS - REGION_ROWS)
    expect(widths[18]).toBe(1)
    expect(widths[19]).toBe(1)
  })
  it("a width-2 pair ending exactly at the last column is allowed", () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines([{ runs: [{ text: "x".repeat(18) + "界", style: "text" }] }, ...rcGrid.slice(1)])
    const out = drawAll(eng)
    expect(out.startsWith(gRow(15, "x".repeat(18) + "界"))).toBe(true)
  })
})

describe("case 5: resize grow 24→30", () => {
  it("next drawRegion lands at the new bottom; committed lines above stay", async () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    eng.resize(COLS, 30)
    expect(eng.regionRows()).toBe(10)
    const out = drawAll(eng)
    // New region top = 30 - 10 = 20 (0-based) → rows 21..30 (1-based).
    expect(out).toBe(
      gRow(21, "rc0") + gRow(22, "rc1") + gRow(23, "rc2") + gRow(24, "rc3") + gRow(25, "rc4") +
      gRow(26, "rc5") + gRow(27, "rc6") + gRow(28, "rc7") + gRow(29, "rc8") + gRow(30, "rc9"),
    )
    const t = new Xterm(COLS, ROWS)
    t.write(drawAll(eng))
    const s = sink()
    eng.commit([{ runs: [{ text: "G0", style: "text" }] }], s.write) // committed while engine is at 24 rows
    t.write(s.bytes())
    t.resize(COLS, 30)
    t.write(out)
    await t.drain()
    expect(t.rows).toBe(30)
    const regionTop = 30 - 10
    expect(Array.from({ length: REGION_ROWS }, (_, i) => t.row(regionTop + i)).join("|")).toBe(rcTexts.join("|"))
    // The committed line is still in the buffer above the region (bottom tail).
    const above: string[] = []
    for (let r = 0; r < regionTop; r++) above.push(t.row(r))
    expect(above.join("|")).toContain("G0")
    expect(above[above.length - 1]).toBe("G0") // directly above the grown region
  })
})

describe("case 6: resize shrink 24→16 (canon clipped to the last lines, region still at the bottom)", () => {
  it("canon longer than the region keeps the LAST lines; drawRegion lands at the new bottom", async () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    const long: RegionLine[] = []
    for (let i = 0; i < 14; i++) long.push(rc2(`cl${i}`))
    eng.setRegionLines(long)
    // setRegionLines clips to the LAST regionRows lines (bottom-anchored).
    expect(eng.regionLines().map((l) => l.runs[0].text)).toEqual(
      ["cl4", "cl5", "cl6", "cl7", "cl8", "cl9", "cl10", "cl11", "cl12", "cl13"],
    )
    const t = new Xterm(COLS, ROWS)
    t.write(drawAll(eng)) // at 24 rows
    const s = sink()
    eng.commit([{ runs: [{ text: "PRE", style: "text" }] }], s.write) // committed while at 24 rows
    t.write(s.bytes())
    await t.drain()
    // Engine shrink to 16 rows: canon stays clipped to the LAST 10 lines.
    eng.resize(COLS, 16)
    expect(eng.regionRows()).toBe(10)
    const out = drawAll(eng)
    // New region top = 16 - 10 = 6 (0-based) → rows 7..16 (1-based).
    expect(out).toBe(
      gRow(7, "cl4") + gRow(8, "cl5") + gRow(9, "cl6") + gRow(10, "cl7") + gRow(11, "cl8") +
      gRow(12, "cl9") + gRow(13, "cl10") + gRow(14, "cl11") + gRow(15, "cl12") + gRow(16, "cl13"),
    )
    t.resize(COLS, 16)
    t.write(out)
    await t.drain()
    expect(t.rows).toBe(16)
    const regionTop = 16 - 10
    expect(Array.from({ length: REGION_ROWS }, (_, i) => t.row(regionTop + i)).join("|"))
      .toBe(["cl4", "cl5", "cl6", "cl7", "cl8", "cl9", "cl10", "cl11", "cl12", "cl13"].join("|"))
    expect(t.row(regionTop - 1)).toBe("PRE") // committed content still above the new bottom
  })
})

describe("case 7: byte minimality (print-once)", () => {
  it("commit#2's bytes contain its own text once and never the previous committed text", () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    const s1 = sink()
    eng.commit([{ runs: [{ text: "ANCHOR-1", style: "text" }] }], s1.write)
    const s2 = sink()
    eng.commit([{ runs: [{ text: "ANCHOR-2", style: "text" }] }], s2.write)
    // print-once: each committed text appears exactly once, in its own commit,
    // and never inside a later commit's byte stream.
    expect(count(s1.bytes(), "ANCHOR-1")).toBe(1)
    expect(count(s1.bytes(), "ANCHOR-2")).toBe(0)
    expect(count(s2.bytes(), "ANCHOR-2")).toBe(1)
    expect(count(s2.bytes(), "ANCHOR-1")).toBe(0)
  })
  it("drawRegion after commits never re-emits committed text", () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    const s = sink()
    eng.commit([{ runs: [{ text: "COMMITTED-TEXT", style: "text" }] }], s.write)
    const s2 = sink()
    eng.drawRegion(s2.write)
    expect(s2.bytes()).not.toContain("COMMITTED-TEXT")
  })
})

describe("case 8: degenerate rows<5 → region 2 rows", () => {
  it("regionRows() === 2 and drawRegion paints exactly the 2 bottom rows", async () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines(rcGrid)
    eng.resize(COLS, 4)
    expect(eng.regionRows()).toBe(2)
    const out = drawAll(eng)
    expect(out).toBe(gRow(3, "rc8") + gRow(4, "rc9")) // canon clipped: LAST 2 rows
    const t = new Xterm(COLS, 4)
    t.write(out)
    await t.drain()
    expect(t.row(2)).toBe("rc8")
    expect(t.row(3)).toBe("rc9")
    expect(t.row(0)).not.toBe("rc8") // rows above hold the committed tail
  })
})

describe("style map: inline SGR for semantic styles (named ANSI-16, terminal-native)", () => {
  it("accent-user + bold region row — deterministic SGR bytes (reset on style change)", () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines([
      { runs: [{ text: "Q ", style: "accent-user" }, { text: "hello", style: "bold" }] },
      ...rcGrid.slice(1),
    ])
    expect(drawAll(eng)).toBe(
      gRow(15, "\x1b[36mQ \x1b[0m\x1b[1mhello") +
      gRow(16, "rc1") + gRow(17, "rc2") + gRow(18, "rc3") + gRow(19, "rc4") +
      gRow(20, "rc5") + gRow(21, "rc6") + gRow(22, "rc7") + gRow(23, "rc8") + gRow(24, "rc9"),
    )
  })
  it("adjacent same-style runs merge (minimal bytes)", () => {
    const eng = createInlineLiveRegion(COLS, ROWS) as InlineLiveRegionImpl
    eng.setRegionLines([{ runs: [{ text: "a", style: "md-code" }, { text: "b", style: "md-code" }] }, ...rcGrid.slice(1)])
    const out = drawAll(eng)
    expect(out.startsWith(gRow(15, "\x1b[36mab"))).toBe(true)
  })
})

/** Default-style region line helper (avoids a duplicate fixture in case 6). */
function rc2(text: string): RegionLine {
  return { runs: [{ text, style: "text" }] }
}
