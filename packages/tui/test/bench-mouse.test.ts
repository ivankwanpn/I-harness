// M47 G1: the mouse/hover bench suite — M39 bench style (GENEROUS thresholds
// for CI noise + console.table so the machine's numbers land, never vacuous).
// The five systems under test:
//   1. HoverEngine (src/app/hover.ts)        — update() O(areas) scan, the
//      unchanged-hover → zero-repaint rule (sameFrame + flush ""), changed →
//      repaint frame cost, against a 5k-line engine + 10k registered areas.
//   2. MouseRouter (src/app/mouse.ts)        — 100 click/drag cycles
//      {down, drag×5, up}: selection set/cleared per loop + 100 clipboard
//      copies (the auto-copy contract).
//   3. ScrollStreamNormalizer (src/app/scroll-stream.ts) — 1000 events/s for
//      2s: per-flush ≤ max(vp/2,6), final drain, pending bound, throughput;
//      plus the forced-trackpad flood (informational — pending growth probe).
//   4. Timeline rail (src/views/timeline.ts + scrollback/engine turnAnchors)
//      — 1000-turn session: turnAnchors() amortized, rail frame cost, chevron
//      jump routing median.
//   5. drawSelectionOverlay (src/app/present.ts) — a selection spanning 5000
//      display lines: the overlay writes O(viewport) cells, not O(span) —
//      counted through the renderer buffer's put() sink.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { HoverEngine } from "../src/app/hover.ts"
import { ScrollStreamNormalizer, flushCapOf } from "../src/app/scroll-stream.ts"
import { MouseRouter } from "../src/app/mouse.ts"
import type { MouseHooks } from "../src/app/mouse.ts"
import { present } from "../src/app/present.ts"
import type { TuiAppState } from "../src/app/present.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import type { ScrollbackEngine, TuiEvent } from "../src/contracts.ts"
import { layoutAgent } from "../src/views/agent.ts"
import { TIMELINE_W } from "../src/views/timeline.ts"
import { DEFAULT_SELECTION_HIGHLIGHT_DURATION_MS } from "../src/app/mouse-consts.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")
const AREA = { cols: 100, rows: 24 }

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

// ------------------------------------------------------------------ fixtures

const WIDTH = 90

/** n user+assistant pairs; each pair = 6 display lines at wide=420. */
const pairs = (n: number, opt: { wide: number } = { wide: 420 }): TuiEvent[] => {
  const evs: TuiEvent[] = []
  for (let i = 0; i < n; i++) {
    evs.push({ type: "user", text: `u${i}`, seq: 2 * i + 1, ts: 0 })
    evs.push({ type: "assistant", text: "x".repeat(opt.wide), seq: 2 * i + 2, ts: 0 })
  }
  return evs
}

/** Engine with n pairs of one user + one wide assistant block. */
const build = (pairsN: number, wide = 420): ScrollbackEngine => {
  const e = createScrollbackEngine({ width: WIDTH })
  for (const ev of pairs(pairsN, { wide })) e.append(ev)
  return e
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
    path: "~/r", tickMs: 0, model: "mock-model", plan: false, contextUsed: undefined,
    contextTotal: undefined, todo: { done: 0, total: 0 }, tasks: { running: 0, labels: [] }, queue: 0, mcp: null,
  },
  turn: undefined,
  toasts: [],
  panes: new Set<string>(),
  shortcuts: { items: [{ key: "j/k", label: "scroll" }] },
  ...partial,
})

const makeClipboard = (): { copied: string[]; copy(text: string): void } => {
  const copied: string[] = []
  return { copied, copy: (t) => { copied.push(t) } }
}

/** Commit→flush; collects the emitted bytes ("" = zero-byte idle). */
const flushCollect = (r: Renderer): string => {
  let out = ""
  r.flush((b) => { out += b })
  return out
}

/** Count every put() the next present() writes through the buffer sink. */
const countPuts = (r: Renderer, fn: () => void): number => {
  const buf = r.buffer as unknown as { put: (x: number, y: number, c: unknown) => void }
  const orig = buf.put.bind(buf)
  let n = 0
  buf.put = (x, y, c) => { n++; orig(x, y, c) }
  try { fn() } finally { buf.put = orig }
  return n
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

interface Row { label: string; result: string; threshold: string; pass: boolean }
const row = (label: string, result: string, threshold: string, pass: boolean): Row => ({ label, result, threshold, pass })

// ------------------------------------------------------------------ 1. hover heavy

describe("bench-mouse — hover heavy (5k-line engine + 10k areas)", () => {
  it("update O(areas) scan + unchanged→zero repaint, changed→repaint frame cost", () => {
    const engine = build(834) // 5004 display lines
    const total = engine.lineCount()
    expect(total).toBeGreaterThan(5000)

    // Engine-level `update(col,row)` against 10k registered areas (O(areas)
    // scan): the pointer never changes the set after the first settle.
    const he = new HoverEngine()
    he.beginFrame()
    for (let i = 0; i < 10_000; i++) he.addArea({ x: 0, y: i, w: 800, h: 1 }, `row-${i}`)
    const N = 200
    const t0 = performance.now()
    let changedSeen = false
    for (let k = 0; k < N; k++) {
      const changed = he.update(2, 3)
      if (k === 0) expect(changed).toBe(true) // empty set → {row-3}: changed
      else { expect(changed).toBe(false); changedSeen ||= true } // unchanged → FALSE dirty
    }
    const scanPerCallMs = (performance.now() - t0) / N
    expect(changedSeen).toBe(true)
    // A move that actually changes the set still costs one scan.
    const t1 = performance.now()
    expect(he.update(2, 5000)).toBe(true)
    const changeCostMs = performance.now() - t1

    // Present-level zero-repaint against the 5k-line engine + hover engine:
    // frame A settles the hover set, frame B draws the hover visual (CHANGED →
    // non-empty bytes), frame C with the SAME pointer → sameFrame + flush "".
    const r = make(90, 24)
    const app = baseState(engine, {
      scroll: { offset: 0, follow: false },
      mouse: { enabled: true, last: { col: 6, row: 3 }, hovered: new Set(), engine: new HoverEngine() },
    })
    const tA = performance.now()
    present(app, r, palette, GLYPHS, { cap })
    const frameA = performance.now() - tA
    flushCollect(r)
    const tB = performance.now()
    const b = present(app, r, palette, GLYPHS, { cap }) // same pointer: hover visual now drawn
    const frameB = performance.now() - tB
    const bytesB = flushCollect(r)
    expect(b.dirty).toBe(true) // changed (first hover repaint)
    expect(bytesB.length).toBeGreaterThan(0)
    const tC = performance.now()
    const c = present(app, r, palette, GLYPHS, { cap })
    const frameC = performance.now() - tC
    const bytesC = flushCollect(r)
    expect(c.dirty).toBe(false) // unchanged hover → sameFrame
    expect(bytesC).toBe("") // zero-byte idle proof

    console.table([
      row(`hover update (10k areas) per call`, `${scanPerCallMs.toFixed(3)}ms`, "< 5ms", scanPerCallMs < 5),
      row(`hover update — single set-change over 10k`, `${changeCostMs.toFixed(2)}ms`, "< 5ms", changeCostMs < 5),
      row(`present frame — hover changed (repaint)`, `${frameB.toFixed(2)}ms`, "< 50ms", frameB < 50),
      row(`present frame — hover unchanged (idle)`, `${frameC.toFixed(2)}ms`, "< 50ms", frameC < 50),
      row(`present frame — hover settle (first)`, `${frameA.toFixed(2)}ms`, "< 50ms", frameA < 50),
      row("hover unchanged → sameFrame + flush bytes", `dirty=${c.dirty} bytes=${JSON.stringify(bytesC)}`, 'dirty=false + bytes=""', c.dirty === false && bytesC === ""),
      row("engine lineCount", `${total}`, "> 5000", total > 5000),
    ])

    expect(scanPerCallMs).toBeLessThan(5)
    expect(changeCostMs).toBeLessThan(5)
    expect(frameB).toBeLessThan(50)
    expect(frameC).toBeLessThan(50)
  })
})

// ------------------------------------------------------------------ 2. click/drag loop

describe("bench-mouse — click/drag loop (100 cycles)", () => {
  it("{down, drag×5, up} ×100: selection set/cleared each loop + 100 clipboard copies", () => {
    const engine = build(20, 60) // ~40 display lines — drag room only
    const app = baseState(engine, { scroll: { offset: 0, follow: true } })
    const clipboard = makeClipboard()
    let t = 0
    const router = new MouseRouter({
      app,
      engine,
      size: () => AREA,
      now: () => t,
      clipboard,
      glyphs: GLYPHS,
      compact: false,
      hooks: { focus: (target) => { app.focused = target } },
    })
    const sb = layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false }).scrollback
    const x = sb.x + 10
    const y0 = sb.y + 2

    const t0 = performance.now()
    for (let cyc = 0; cyc < 100; cyc++) {
      t += 450 // outside the 300ms multi-click window — every cycle is a NEW gesture
      router.handle({ x, y: y0, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
      for (let m = 1; m <= 5; m++) {
        router.handle({ x, y: y0 + m, button: "left", kind: "motion", drag: true, mods: { ctrl: false, shift: false, alt: false } })
        expect(engine.selection()).toBeDefined() // selection SET during the drag
      }
      router.handle({ x, y: y0 + 5, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
      expect(clipboard.copied.length).toBe(cyc + 1) // auto-copy on up, every cycle
      expect(app.selectionFlashUntil).toBeDefined()
      // Flash expiry on the router's frame → selection CLEARED.
      t += DEFAULT_SELECTION_HIGHLIGHT_DURATION_MS + 10
      router.frame(t)
      expect(engine.selection()).toBeUndefined()
    }
    const ms = performance.now() - t0
    expect(clipboard.copied.length).toBe(100)
    expect(clipboard.copied.every((s) => s.length > 0)).toBe(true)

    console.table([
      row("click/drag 100 cycles {down,5×drag,up}", `${ms.toFixed(0)}ms`, "< 5000ms", ms < 5000),
      row("clipboard copies (auto-copy on up)", `${clipboard.copied.length}`, "= 100", clipboard.copied.length === 100),
      row("selection survivors after flash frames", `${engine.selection() === undefined ? 0 : 1}`, "0 (all cleared)", engine.selection() === undefined),
    ])
    expect(ms).toBeLessThan(5000)
  })
})

// ------------------------------------------------------------------ 3. scroll-stream overload

describe("bench-mouse — scroll-stream overload (1000 events/s, 2s)", () => {
  it("per-flush ≤ max(vp/2,6), final drain, pending bound, throughput", () => {
    const ns = new ScrollStreamNormalizer(
      { brand: "WindowsTerminal", multiplexer: "none" },
      { speed: 50, mode: "auto", invert: false },
      { viewportRows: 24 },
    )
    const capFlush = flushCapOf(ns.config)
    expect(capFlush).toBe(12) // max(24/2, 6)

    // 2000 events at 1ms → the requested 1000 events/s for 2s (fake ticks).
    const t0 = performance.now()
    let delivered = 0
    let maxLag = 0
    let maxFlush = 0
    for (let i = 0; i < 2000; i++) {
      const u = ns.push("down", i)
      expect(Math.abs(u.lines)).toBeLessThanOrEqual(capFlush) // per-flush cap
      maxFlush = Math.max(maxFlush, Math.abs(u.lines))
      delivered += u.lines
      // demand after event i+1 (ept=3 wheel → 1 line/event at speed 1).
      maxLag = Math.max(maxLag, Math.abs(i + 1 - delivered))
    }
    const feedMs = performance.now() - t0
    const rate = 2000 / (feedMs / 1000)

    // Drain: the 80ms gap finalizes the stream; the taper never exceeds cap.
    let drain = 0
    let steps = 0
    let u = ns.onTick(3000) // gap >> 80ms
    while (u.active === true && steps < 100) {
      expect(Math.abs(u.lines)).toBeLessThanOrEqual(capFlush)
      maxFlush = Math.max(maxFlush, Math.abs(u.lines))
      drain += u.lines
      steps++
      u = ns.onTick(3000 + steps * 16)
    }
    expect(ns.hasActiveStream()).toBe(false) // final drained
    const total = delivered + drain
    expect(total).toBeCloseTo(2000, 3) // every demanded line was delivered
    expect(maxLag).toBeLessThanOrEqual(2 * capFlush) // pending ≤ 2×cap throughout

    console.table([
      row(`stream 1000 ev/s × 2s — processed (events/sec)`, `${rate.toFixed(0)}/s`, "> 3000/s", rate > 3000),
      row(`stream per-flush max`, `≤ ${capFlush} (observed ${maxFlush})`, "≤ max(vp/2,6) = 12", maxFlush <= capFlush),
      row(`stream pending max (lag vs demand)`, `${maxLag} lines`, "≤ 2×cap = 24", maxLag <= 2 * capFlush),
      row(`stream final drain — delivered/demand`, `${total}/${2000}`, "= demand", Math.abs(total - 2000) < 0.001),
      row("stream hasActiveStream after drain", `${ns.hasActiveStream()}`, "false", ns.hasActiveStream() === false),
    ])
    expect(rate).toBeGreaterThan(3000)
  })

  it("flood probe — forced-trackpad speed-100 (informational: per-flush cap holds, pending growth logged)", () => {
    const ns = new ScrollStreamNormalizer(
      { brand: "VsCode", multiplexer: "none" },
      { speed: 100, mode: "trackpad", invert: false },
      { viewportRows: 24 },
    )
    const capFlush = flushCapOf(ns.config)
    // 250 events at 8ms (125/s sustained): accel-weighted trackpad demand is
    // 15/3 × 6 = 30 lines per event — the flood cap exercises.
    let delivered = 0
    let maxLag = 0
    const t0 = performance.now()
    for (let i = 0; i < 250; i++) {
      const u = ns.push("down", i * 8)
      expect(Math.abs(u.lines)).toBeLessThanOrEqual(capFlush) // THE cap always holds
      delivered += u.lines
      maxLag = Math.max(maxLag, (i + 1) * 30 - delivered)
    }
    const feedMs = performance.now() - t0
    let drain = 0
    let steps = 0
    let u = ns.onTick(250 * 8 + 1)
    while (u.active === true && steps < 200) {
      expect(Math.abs(u.lines)).toBeLessThanOrEqual(capFlush)
      drain += u.lines
      steps++
      u = ns.onTick(250 * 8 + 1 + steps * 16)
    }
    const dropped = 250 * 30 - delivered - drain
    console.table([
      row("flood per-flush max (cap respected)", `≤ ${capFlush}`, "≤ 12", true),
      row("flood pending max (lag, informational)", `${maxLag} lines`, "LOUD finding — grows past 2×cap", false),
      row("flood final drain delivered", `${drain} lines`, "taper only", drain <= 2 * capFlush),
      row("flood backlog dropped at finalize", `${dropped} lines`, "intentional (cap-induced discard)", true),
      row(`flood feed ${(250 * 0.008).toFixed(0)}s wall (${feedMs.toFixed(0)}ms)`, `${(250 * 1000 / feedMs).toFixed(0)}/s`, "> 1000/s", 250 * 1000 / feedMs > 1000),
    ])
  })
})

// ------------------------------------------------------------------ 4. timeline rail

describe("bench-mouse — timeline rail (1000-turn session)", () => {
  it("turnAnchors amortized + rail frame cost + chevron jump routing median", () => {
    const e = createScrollbackEngine({ width: WIDTH })
    let seq = 0
    for (let i = 0; i < 1000; i++) {
      e.append({ type: "user", text: `turn-${i}`, seq: ++seq, ts: i } as TuiEvent)
      e.append({ type: "assistant", text: "ok", seq: ++seq, ts: i } as TuiEvent)
    }
    expect(e.turnAnchors?.().length).toBe(1000)

    // turnAnchors() amortized: N calls over the 1000-turn session.
    const N = 100
    const t0 = performance.now()
    let lastCount = 0
    for (let i = 0; i < N; i++) lastCount = e.turnAnchors?.().length ?? 0
    const bulkMs = performance.now() - t0
    const perCallMs = bulkMs / N
    expect(lastCount).toBe(1000)

    // Rail render: present over the 24-row viewport with the rail live.
    const r = make(90, 24)
    const app = baseState(e, {
      showTimeline: true,
      scroll: { offset: 0, follow: false },
      mouse: { enabled: true, last: { col: 88, row: 5 }, hovered: new Set(), engine: new HoverEngine() },
    })
    present(app, r, palette, GLYPHS, { cap }) // warm (registers + settles)
    flushCollect(r)
    const F = 50
    const t1 = performance.now()
    for (let i = 0; i < F; i++) {
      present(app, r, palette, GLYPHS, { cap })
      flushCollect(r)
    }
    const frameMs = (performance.now() - t1) / F

    // Chevron click routing (timelineDown → jumpToAnchor → the /jump seam):
    // 200 clicks alternating top/bottom chevrons; report the median.
    const app2 = baseState(e, { showTimeline: true, scroll: { offset: 0, follow: false } })
    const clipboard2 = makeClipboard()
    let jumps = 0
    const hooks: MouseHooks = { timelineJump: () => { jumps++ } }
    const router = new MouseRouter({
      app: app2, engine: e, size: () => AREA, now: () => 0, clipboard: clipboard2, glyphs: GLYPHS,
      compact: false, hooks,
    })
    const sb = layoutAgent(AREA, { ...app2, dropdown: undefined }, { compact: false }).scrollback
    const cx = sb.x + sb.w - TIMELINE_W
    const times: number[] = []
    for (let i = 0; i < 200; i++) {
      const y = i % 2 === 0 ? sb.y : sb.y + sb.h - 1
      const tj = performance.now()
      router.handle({ x: cx, y, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
      times.push(performance.now() - tj)
    }
    const medianMs = median(times)
    expect(jumps).toBe(200) // both chevrons reachable at offset 0

    console.table([
      row(`turnAnchors() ×${N} bulk (1000 turns)`, `${bulkMs.toFixed(1)}ms (${perCallMs.toFixed(2)}ms/call)`, "< 200ms bulk", bulkMs < 200),
      row(`rail present frame (24-row, live rail)`, `${frameMs.toFixed(2)}ms`, "< 50ms", frameMs < 50),
      row(`chevron jump routing median (200 clicks)`, `${medianMs.toFixed(3)}ms`, "< 5ms", medianMs < 5),
      row("chevron jumps routed", `${jumps}`, "= 200", jumps === 200),
    ])
    expect(bulkMs).toBeLessThan(200)
    expect(frameMs).toBeLessThan(50)
    expect(medianMs).toBeLessThan(5)
  })
})

// ------------------------------------------------------------------ 5. selection overlay span

describe("bench-mouse — selection overlay span (5000 lines)", () => {
  it("writes O(viewport) cells not O(span) + frame cost", () => {
    const engine = build(834) // 5004 display lines
    const total = engine.lineCount()
    expect(total).toBeGreaterThan(5000)
    const r = make(90, 24)
    const app = baseState(engine, { scroll: { offset: 0, follow: false } })

    // Exact overlay-cell count: the ONLY difference between frames with and
    // without a selection is the overlay pass (no re-layout — same runs).
    const baseWrites = countPuts(r, () => { present(app, r, palette, GLYPHS, { cap }); flushCollect(r) })
    engine.setSelection(0, total - 1) // the 5000-line span
    const bigWrites = countPuts(r, () => { present(app, r, palette, GLYPHS, { cap }); flushCollect(r) })
    engine.setSelection(0, 23) // the 24-line span in the same viewport
    const smallWrites = countPuts(r, () => { present(app, r, palette, GLYPHS, { cap }); flushCollect(r) })
    const bigDelta = bigWrites - baseWrites
    const smallDelta = smallWrites - baseWrites
    // O(viewport): the huge span draws the IDENTICAL overlay cells (clamped).
    expect(bigDelta).toBe(smallDelta)
    expect(bigDelta).toBeGreaterThan(0) // the overlay really wrote border cells
    expect(bigDelta).toBeLessThan(4 * 90) // ≤ ~2 cells × 24 rows + 2 dashed rows

    // Frame cost with the huge span (30 frames, averaged).
    engine.setSelection(0, total - 1)
    const F = 30
    const t0 = performance.now()
    for (let i = 0; i < F; i++) {
      present(app, r, palette, GLYPHS, { cap })
      flushCollect(r)
    }
    const frameMs = (performance.now() - t0) / F

    console.table([
      row(`5k-span overlay overlay-cell writes`, `${bigDelta} cells (24-line span: ${smallDelta})`, "O(viewport) — < 360, deep under 2×span", bigDelta < 360),
      row(`5k-span overlay identical to 24-line span`, `${bigDelta === smallDelta}`, "true", bigDelta === smallDelta),
      row(`5k-span present frame (24-row viewport)`, `${frameMs.toFixed(2)}ms`, "< 50ms", frameMs < 50),
    ])
    expect(frameMs).toBeLessThan(50)
  })
})
