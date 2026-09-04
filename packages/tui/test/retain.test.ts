// M39 G2: scrollback retain() — display-trunk memory release.
// Semantics: the leading blocks collapse into ONE marker row
// (`  … earlier {N} lines`, muted/collapsed); the block model + seq cursor
// stay; appends keep working (tail-only); search scope = visible lines.
// Threshold/geometry invariants are exact (width 30 → inner 25 → 60-char
// assistant = 3 wrapped lines, user = 1 line, 4 lines per pair).

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import type { BackendClient, DisplayLine, ScrollbackEngine, TuiEvent } from "../src/contracts.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const stubBackend = (): BackendClient => ({
  listSessions: async () => [],
  open: async () => {},
  submit: async () => {},
  steer: async () => {},
  cancel: async () => {},
  events: async function* () {},
  seqCursor: () => 0,
  replay: async () => [],
  status: () => ({ running: false, queued: 0 }),
  close: async () => {},
})

const WIDTH = 30
const INNER = WIDTH - 6 // accent 1 + pads 4 + bullet 1 (layout.innerWidth)

function eng() {
  return createScrollbackEngine({ width: WIDTH, showTimestamps: false })
}

const usr = (text: string, seq: number): TuiEvent => ({ type: "user", text, seq, ts: 0 })
const asst = (text: string, seq: number): TuiEvent => ({ type: "assistant", text, seq, ts: 0 })

/** 500 user/assistant pairs: 1000 blocks, 4 display lines a pair → 2000. */
function appendPairs(e: ReturnType<typeof eng>, n: number, seqStart = 0): void {
  for (let i = 0; i < n; i++) {
    e.append(usr(`u${seqStart + i}`, seqStart * 2 + 2 * i + 1))
    e.append(asst("x".repeat(60), seqStart * 2 + 2 * i + 2))
  }
}

const lineText = (l: DisplayLine): string => l.runs.map((r) => r.text).join("")

/** retain is contract-optional — tests use the real engine, call it surely. */
const retainOf = (e: ScrollbackEngine, opts: { maxLines?: number }): { trimmedBlocks: number } =>
  e.retain !== undefined ? e.retain(opts) : { trimmedBlocks: 0 }

describe("retain — display trunk trim", () => {
  it("trims the leading blocks into one marker; lineCount = horizon + marker", () => {
    const e = eng()
    appendPairs(e, 500)
    expect(e.lineCount()).toBe(2000)
    const r = retainOf(e, { maxLines: 200 })
    expect(r.trimmedBlocks).toBe(900) // first 450 pairs (900 blocks) suppressed
    // 200 kept display lines + 1 marker row.
    expect(e.lineCount()).toBe(201)
  })

  it("the marker row: `  … earlier {N} lines`, muted, collapsed, no glyph/anchor", () => {
    const e = eng()
    appendPairs(e, 500)
    retainOf(e, { maxLines: 200 })
    const top = e.viewport(0, 2)
    const marker = top[0]
    expect(lineText(marker)).toBe("  … earlier 1800 lines")
    expect(marker.runs[0].style).toBe("muted")
    expect(marker.collapsed).toBe(true)
    expect(marker.glyph).toBeUndefined()
    expect(marker.anchor).toBeUndefined()
    expect(marker.timestamp).toBeUndefined()
    // the kept tail still renders — past the sticky pin (offset 199 ≥ userEnd
    // 198): [sticky u499, x×24, x×12] — the last wrap remainder of lines.
    const tail = e.viewport(199, 3)
    expect(lineText(tail[tail.length - 1])).toBe("x".repeat(12))
    expect(tail.some((l) => l.sticky === true)).toBe(true)
  })

  it("idempotent — an unchanged retain trims nothing", () => {
    const e = eng()
    appendPairs(e, 500)
    retainOf(e, { maxLines: 200 })
    expect(retainOf(e, { maxLines: 200 })).toEqual({ trimmedBlocks: 0 })
    expect(e.lineCount()).toBe(201)
  })

  it("appends after retain grow the tail; the marker stays pinned", () => {
    const e = eng()
    appendPairs(e, 500)
    expect(retainOf(e, { maxLines: 200 }).trimmedBlocks).toBe(900)
    appendPairs(e, 1, 500)
    expect(e.lineCount()).toBe(205)
    expect(lineText(e.viewport(0, 1)[0])).toBe("  … earlier 1800 lines")
  })

  it("seq cursor sanity — a re-delivered seq is ignored after retain", () => {
    const e = eng()
    appendPairs(e, 500)
    retainOf(e, { maxLines: 200 })
    const before = e.lineCount()
    e.append(usr("dup", 3)) // seq 3 already applied
    e.append(asst("z".repeat(20), 9))
    expect(e.lineCount()).toBe(before)
  })

  it("search after retain = visible display lines only (trimmed region gone)", () => {
    const e = eng()
    appendPairs(e, 500)
    retainOf(e, { maxLines: 200 })
    // u0 is inside the trimmed region (0 matches) — honest search scope.
    expect(e.search("u0")).toBe(0)
    expect(e.matches()).toEqual([])
    // u450 is the first kept user block — the markert is line 0, so it sits at 1.
    expect(e.search("u450")).toBe(1)
    expect(e.matches()).toEqual([1])
    // the marker row itself is a visible line.
    expect(e.search("earlier")).toBe(1)
    expect(e.matches()).toEqual([0])
  })

  it("toggling the marker is a safe no-op; kept blocks still fold", () => {
    const e = eng()
    appendPairs(e, 500)
    retainOf(e, { maxLines: 200 })
    const before = e.lineCount()
    e.toggleFoldAt(0) // marker — no-op
    expect(e.lineCount()).toBe(before)
    expect(e.lineBlock(0)).toBeUndefined()
    // kept-line fold still works: the kept 5-row user is auto-collapsed at
    // push (>3 rows → cap 3) and still toggles to full (expanded).
    const f = eng()
    f.append(asst("x\ny\nz\nw\nv", 1)) // 5 rows
    f.append(usr("a\nb\nc\nd\ne", 2)) // 5 rows, auto-collapsed→3 (latest user)
    expect(f.lineCount()).toBe(8)
    const r = retainOf(f, { maxLines: 5 })
    expect(r.trimmedBlocks).toBe(1)
    expect(f.lineCount()).toBe(4) // marker(1) + kept user(3)
    f.toggleFoldAt(1)
    expect(f.lineCount()).toBe(6) // …and the fold still works (3 → 5 rows)
  })

  it("the sticky-pinned latest user survives retain", () => {
    const e = eng()
    appendPairs(e, 500)
    retainOf(e, { maxLines: 200 })
    // Visible 201 lines: marker(0) + blocks 900..999 (200 lines). The last
    // user block is at visible 197 (block 998 = user 499). Scrolled past it
    // (offset 198 ≥ userEnd 198) the sticky header appears.
    const lines = e.viewport(198, 2)
    expect(lines[0].sticky).toBe(true)
    expect(lineText(lines[0])).toContain("u499")
  })

  it("streaming (open) blocks are never trimmed", () => {
    const e = eng()
    appendPairs(e, 250) // 1000 lines (seqs 1..500)
    e.append(usr("u-final", 501)) // closes the last pair's assistant
    e.append(asst("y".repeat(500), 502)) // 21 lines — open assistant at the tail
    expect(e.lineCount()).toBe(1022)
    retainOf(e, { maxLines: 100 })
    expect(e.lineCount()).toBe(99) // marker(1) + 98 kept — tail = open asst
    // the open assistant is still the visible tail (not collapsed into the
    // marker): past the sticky pin — [sticky u-final, y×24, y×20].
    const tail = e.viewport(97, 3)
    expect(lineText(tail[tail.length - 1])).toBe("y".repeat(20))
  })

  it("a huge single block is never split — the last block always stays", () => {
    const e = eng()
    e.append(asst("q".repeat(2000), 1)) // 84 lines alone
    e.append(asst("q".repeat(2000), 2)) // streams into the same block — 167 lines
    expect(e.lineCount()).toBe(167)
    expect(retainOf(e, { maxLines: 10 })).toEqual({ trimmedBlocks: 0 })
    expect(e.lineCount()).toBe(167) // nothing trimmable (single live block)
    expect(lineText(e.viewport(0, 1)[0])).toBe("q".repeat(INNER))
  })
})

/* ------------------------------------------------------- loop-level wiring */

describe("TuiApp retain wiring (M39)", () => {
  // width 100 → inner 95: 400-char assistant = 5 wrapped lines + 1 user = 6/pair.
  const pairs = (n: number): TuiEvent[] => {
    const evs: TuiEvent[] = []
    for (let i = 0; i < n; i++) {
      evs.push({ type: "user", text: `u${i}`, seq: 2 * i + 1, ts: 0 })
      evs.push({ type: "assistant", text: "z".repeat(400), seq: 2 * i + 2, ts: 0 })
    }
    return evs
  }

  const makeApp = (engine: ReturnType<typeof createScrollbackEngine>): TuiApp => new TuiApp({
    renderer: createRenderer({ cols: 100, rows: 24, cap }),
    backend: stubBackend(),
    engine,
    capabilities: cap,
    palette,
    glyphs: GLYPHS,
    write: () => {},
  })

  it("setSize auto-trigger: a >2000-line scrollback trims to ~1500 on resize", () => {
    const engine = createScrollbackEngine({ width: 100 })
    for (const ev of pairs(525)) engine.append(ev) // 525 × 6 = 3150 lines
    expect(engine.lineCount()).toBe(3150)
    const app = makeApp(engine)
    app.setSize(100, 24) // re-wrap + the documented auto-retain heuristic
    expect(engine.lineCount()).toBeLessThan(2000)
    expect(engine.lineCount()).toBeGreaterThan(1400)
    // the marker is the pinned top row of the trimmed scrollback.
    expect(engine.viewport(0, 1)[0].runs[0].text).toContain("earlier")
  })

  it("app.retain(maxLines) is the manual hook and reports the trimmed blocks", () => {
    const engine = createScrollbackEngine({ width: 100 })
    for (const ev of pairs(525)) engine.append(ev)
    const app = makeApp(engine)
    const r = app.retain(100) // budget 100 → 96 kept (16 pairs) + marker
    expect(r.trimmedBlocks).toBeGreaterThan(0)
    expect(engine.lineCount()).toBeLessThanOrEqual(101)
    expect(engine.lineCount()).toBeGreaterThanOrEqual(90)
    expect(engine.viewport(0, 1)[0].runs[0].text).toContain("earlier")
  })
})
