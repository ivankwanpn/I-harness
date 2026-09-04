// M39 G2: the FPS HUD — FpsMeter math, the top-right 32-col panel through
// present()/renderHud (cells + styles), and the loop wiring (hud option
// allocates the meter, ticks per frame, zero cost when off).

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { FpsMeter, renderHud } from "../src/app/hud.ts"
import { makeDraw, present } from "../src/app/present.ts"
import type { TuiAppState } from "../src/app/present.ts"
import { TuiApp } from "../src/app/loop.ts"
import type { BackendClient, DisplayLine, ScrollbackEngine, TuiEvent } from "../src/contracts.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

const rgb = (hex: string): { r: number; g: number; b: number } => {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}

/** Visible text of one drawn row (reads the committed front frame). */
const rowText = (r: Renderer, y: number): string => {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string }>; width: number } } }
  const { cells, width } = inner.db.front
  let out = ""
  for (let x = 0; x < width; x++) out += cells[y * width + x].text
  return out
}

const cellAt = (r: Renderer, x: number, y: number): { text: string; style: unknown } => {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string; style: unknown }>; width: number } } }
  return inner.db.front.cells[y * inner.db.front.width + x]
}

class StubEngine implements ScrollbackEngine {
  constructor(public lines: DisplayLine[] = []) {}
  append(_ev: TuiEvent): void {}
  lineCount(): number { return this.lines.length }
  viewport(offset: number, height: number): DisplayLine[] {
    return this.lines.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, height))
  }
  lineBlock(): { title: string; runs: DisplayLine["runs"] } | undefined { return undefined }
  toggleFoldAt(): void {}
  toggleExpandAll(): void {}
  setSelection(): void {}
  selection(): { a: number; b: number } | undefined { return undefined }
  search(): number { return -1 }
  clearSearch(): void {}
  matches(): number[] { return [] }
  nextMatch(): number { return 0 }
  prevMatch(): number { return 0 }
  setWidth(): void {}
}

const baseState = (engine: ScrollbackEngine, partial: Partial<TuiAppState> = {}): TuiAppState => ({
  title: "sup",
  mode: "normal",
  engine,
  prompt: { text: "", cursor: 0, multiLine: false, focused: true, model: "mock-model", plan: false, title: "sup" },
  promptCursor: 0,
  history: [],
  historyIndex: 0,
  scroll: { offset: 0, follow: true },
  focused: "prompt",
  search: undefined,
  status: {
    path: "~/r",
    tickMs: 0,
    model: "mock-model",
    plan: false,
    contextUsed: undefined,
    contextTotal: undefined,
    todo: { done: 0, total: 0 },
    tasks: { running: 0, labels: [] },
    queue: 0,
    mcp: null,
  },
  turn: undefined,
  toasts: [],
  panes: new Set<string>(),
  shortcuts: { items: [{ key: "j/k", label: "scroll" }] },
  ...partial,
})

const line = (text: string): DisplayLine => ({ runs: [{ text, style: "text" }], blockIndex: 0 })
const fiveLines = (): DisplayLine[] => [line("a"), line("b"), line("c"), line("d"), line("e")]

/* ---------------------------------------------------------------- FpsMeter */

describe("FpsMeter", () => {
  it("no samples → zeros; start() resets the window", () => {
    const m = new FpsMeter()
    expect(m.stats()).toEqual({ fps: 0, p50: 0, p95: 0 })
    m.start()
    expect(m.stats()).toEqual({ fps: 0, p50: 0, p95: 0 })
  })

  it("steady 20ms intervals → 50 fps, p50/p95 = 20ms", () => {
    const m = new FpsMeter()
    m.start()
    for (let i = 1; i <= 50; i++) m.tick(i * 20)
    const s = m.stats()
    expect(s.fps).toBe(50)
    expect(s.p50).toBe(20)
    expect(s.p95).toBe(20)
  })

  it("mixed window → nearest-rank percentiles + mean fps", () => {
    const m = new FpsMeter()
    m.start()
    // intervals: 10,10,20,30,30,40 → samples [10,20,30,30,40]
    let t = 0
    for (const dt of [10, 10, 20, 30, 30, 40]) {
      t += dt
      m.tick(t)
    }
    // nearest-rank: p50 = sorted[ceil(0.5·5)−1] = 30; p95 = sorted[4] = 40.
    expect(m.stats()).toMatchObject({ fps: 38, p50: 30, p95: 40 })
  })

  it("rolling window: only the last `window` samples count", () => {
    const m = new FpsMeter(8)
    m.start()
    // 200 × 10ms, then 20 × 100ms — window(8) keeps only the silent frames…
    let t = 0
    for (let i = 0; i < 200; i++) { t += 10; m.tick(t) } // fills the buffer
    // the oldest samples (fast) are evicted by the slow batch
    for (let i = 0; i < 20; i++) { t += 100; m.tick(t) }
    expect(m.stats().fps).toBe(10) // 1000/100 — the 10ms frames are gone
  })

  it("a long stall is dropped from the window (paused pump ≠ fps signal)", () => {
    const m = new FpsMeter()
    m.start()
    m.tick(0)
    m.tick(20)
    m.tick(60_000) // 60s gap — dropped
    m.tick(60_020)
    expect(m.stats()).toMatchObject({ p50: 20, p95: 20 })
  })
})

/* ------------------------------------------------------------ renderHud */

describe("renderHud — the 32-col top-right band", () => {
  it("row 0 = fps/p50/p95; row 1 = scroll lineCount; band fills the rect", () => {
    const r = make(80, 20)
    const meter = new FpsMeter()
    meter.start()
    for (let i = 1; i <= 25; i++) meter.tick(i * 20)
    renderHud(r.buffer, { meter, lineCount: 5 }, { x: 80 - 32, y: 0, w: 32, h: 2 }, makeDraw(r.buffer, palette), palette)
    r.commit()
    expect(rowText(r, 0).slice(80 - 32)).toBe("fps:50 p50:20ms p95:20ms".padEnd(32))
    expect(rowText(r, 1).slice(80 - 32)).toBe("scroll: 5 lines".padEnd(32))
    // band style: text_secondary fg on bg_visual bg, every cell of the rect.
    expect(cellAt(r, 80 - 32, 0).style).toMatchObject({ fg: rgb(palette.textSecondary), bg: rgb(palette.bgVisual) })
    expect(cellAt(r, 79, 0).style).toMatchObject({ bg: rgb(palette.bgVisual) })
    expect(cellAt(r, 80 - 32, 1).style).toMatchObject({ bg: rgb(palette.bgVisual) })
    // cells OUTSIDE the rect stay untouched (no band on the left side).
    expect(cellAt(r, 40, 0).style).not.toMatchObject({ bg: rgb(palette.bgVisual) })
  })

  it("no scroll row while the scrollback is empty", () => {
    const r = make(60, 10)
    renderHud(r.buffer, { meter: new FpsMeter(), lineCount: 0 }, { x: 60 - 32, y: 0, w: 32, h: 2 }, makeDraw(r.buffer, palette), palette)
    r.commit()
    expect(rowText(r, 0).slice(60 - 32)).toBe("fps:0 p50:0ms p95:0ms".padEnd(32))
    // row 1 untouched — no band painted here.
    expect(cellAt(r, 50, 1).style).not.toMatchObject({ bg: rgb(palette.bgVisual) })
  })
})

/* ---------------------------------------------------------- present-level */

describe("present() with the hud option", () => {
  const draw = (state: TuiAppState, r: Renderer, hud?: { meter: FpsMeter; lineCount: number }) => {
    present(state, r, palette, GLYPHS, hud === undefined ? {} : { hud })
    return r.flush(() => {})
  }

  it("panel drawn top-right, above the status row, with the meter's stats", () => {
    const r = make(100, 24)
    const meter = new FpsMeter()
    meter.start()
    for (let i = 1; i <= 25; i++) meter.tick(i * 20)
    draw(baseState(new StubEngine(fiveLines())), r, { meter, lineCount: 5 })
    expect(rowText(r, 0).slice(100 - 32)).toBe("fps:50 p50:20ms p95:20ms".padEnd(32))
    expect(rowText(r, 1).slice(100 - 32)).toBe("scroll: 5 lines".padEnd(32))
    // the RIGHT edge of the status row shows the band (drawn last).
    expect(cellAt(r, 99, 0).style).toMatchObject({ bg: rgb(palette.bgVisual) })
  })

  it("no hud option → no panel, zero extra cells touched", () => {
    const r = make(100, 24)
    draw(baseState(new StubEngine(fiveLines())), r)
    // row 0 right side is the status line's own content, no bg visual band.
    expect(cellAt(r, 99, 0).style).not.toMatchObject({ bg: rgb(palette.bgVisual) })
    expect(rowText(r, 0).slice(100 - 32)).not.toContain("fps:")
  })
})

/* ------------------------------------------------------------ loop wiring */

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

describe("TuiApp hud wiring", () => {
  it("hud:true → the meter ticks per frame() and the panel shows real stats", () => {
    let now = 0
    const r = make(100, 24)
    const app = new TuiApp({
      renderer: r,
      backend: stubBackend(),
      engine: createScrollbackEngine({ width: 100 }),
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: () => {},
      now: () => now,
      hud: true,
    })
    now = 20
    app.frame() // baseline interval — the panel renders the zeros
    expect(rowText(r, 0).slice(100 - 32)).toBe("fps:0 p50:0ms p95:0ms".padEnd(32))
    now = 40
    app.frame() // 20ms interval → 50 fps
    now = 60
    app.frame()
    expect(rowText(r, 0).slice(100 - 32)).toBe("fps:50 p50:20ms p95:20ms".padEnd(32))
  })

  it("hud:false → no meter, no panel (zero-overhead path)", () => {
    const r = make(100, 24)
    const app = new TuiApp({
      renderer: r,
      backend: stubBackend(),
      engine: createScrollbackEngine({ width: 100 }),
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: () => {},
      now: () => 20,
    })
    app.frame()
    expect(rowText(r, 0).slice(100 - 32)).not.toContain("fps:")
    expect(cellAt(r, 99, 0).style).not.toMatchObject({ bg: rgb(palette.bgVisual) })
  })
})
