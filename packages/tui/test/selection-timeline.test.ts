// M46c G1: selection borders + timeline rail — the renderable surface that
// M46b's mouse state (engine.selection / selectionFlashUntil / drag tape
// mirror) now paints. The golden tests assert the DRAWN cell grid through the
// REAL engine + present (the same draw point as the app):
//   - selection: none / flash-visible box / hold / word_select single-row /
//     clip-top + clip-bottom sides (`┆`) / the ✗ replacement cell / the ▏
//     drag tape (no re-layout — the rows' own runs keep their cells);
//   - timeline: gate (showTimeline + width + turns), tick states (━━/──/ ─),
//     chevrons, the hover popup card, the active-turn resolution;
//   - router: chevron/tick click → the /jump goTo seam + the scrollbar
//     latch suppression while the rail is on; the ✗ click-to-clear.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import type { ScrollbackEngine, TuiEvent } from "../src/contracts.ts"
import { present } from "../src/app/present.ts"
import type { TuiAppState } from "../src/app/present.ts"
import { HoverEngine } from "../src/app/hover.ts"
import { MouseRouter } from "../src/app/mouse.ts"
import type { MouseHooks } from "../src/app/mouse.ts"
import { layoutAgent } from "../src/views/agent.ts"
import type { Rect } from "../src/views/agent.ts"
import { timelineActive, activeTurnIndex } from "../src/views/timeline.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

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

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

/** The committed front frame's cell. */
const cellAt = (r: Renderer, x: number, y: number): { text: string; style: Record<string, unknown> } => {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string; style: Record<string, unknown> }>; width: number } } }
  const { cells, width } = inner.db.front
  return cells[y * width + x]
}

const draw = (app: TuiAppState, r: Renderer): void => {
  present(app, r, palette, GLYPHS, {})
  r.flush(() => {})
}

/// The engine turn anchors (safe member access / declared-optional accessor).
const anchorsOf = (e: ScrollbackEngine): Array<{ lineIndex: number; preview: string }> =>
  e.turnAnchors?.() ?? []

/** Append with a fresh increasing seq (the engine dedups on seq — the seeds
 * must carry distinct monotone seqs or the later events are dropped). */
let seqN = 0
const push = (e: ScrollbackEngine, ev: Record<string, unknown>): void => {
  seqN++
  e.append({ ...ev, seq: seqN } as unknown as TuiEvent)
}

/** Seed A: 3 display lines (user hello; assistant two lines) — the minimal
 * selection golden scene. */
function seedA(): ScrollbackEngine {
  const e = createScrollbackEngine({ width: 80 })
  push(e, { type: "user", text: "hello", ts: 100 })
  push(e, { type: "assistant", text: "two lines\nthird line", ts: 200 })
  return e
}

/** Seed B: two turns (anchors at line 0 and line 10) — the timeline golden
 * scene (user hello / assistant 2 / execute collapsed 7 / user again /
 * assistant tail = 12 display lines at 80 cols). */
function seedB(): ScrollbackEngine {
  const e = createScrollbackEngine({ width: 80 })
  push(e, { type: "user", text: "hello", ts: 100 })
  push(e, { type: "assistant", text: "two lines\nthird line", ts: 200 })
  push(e, {
    type: "tool", callId: "r1", name: "run x", kind: "execute", status: "done",
    output: "d-1\nd-2\nd-3\nd-4\nd-5\nd-6", summary: "run x", ts: 300,
  })
  push(e, { type: "user", text: "again", ts: 400 })
  push(e, { type: "assistant", text: "tail", ts: 500 })
  return e
}

/** Seed C: seedB + an expanded 13-row edit block (25 lines) — the CLIP
 * goldens need a scene taller than the 13-row viewport. */
function seedC(): ScrollbackEngine {
  const e = seedB()
  push(e, {
    type: "tool", callId: "e1", name: "patch.txt", kind: "edit", status: "done",
    output: "+a1\n+a2\n+a3\n+a4\n+a5\n+a6\n-b1\n-b2\n-b3\n-b4\n-b5\n-b6", summary: "patch.txt", ts: 600,
  })
  return e
}

/** Seed D: three turns (anchors at line 0 / 10 / 19 + a filler execute) —
 * the chevron clicks need an anchor BEYOND the 13-row default viewport so
 * `next` is reachable at offset 0 (at off 0 the active = the LAST anchor
 * the viewport bottom covers = turn 2 at line 10). */
function seedD(): ScrollbackEngine {
  const e = seedB()
  push(e, {
    type: "tool", callId: "r2", name: "run y", kind: "execute", status: "done",
    output: "x-1\nx-2\nx-3\nx-4\nx-5\nx-6", summary: "run y", ts: 600,
  })
  push(e, { type: "user", text: "third", ts: 700 })
  push(e, { type: "assistant", text: "t3", ts: 800 })
  return e
}

describe("selection borders (M46c G1) — the overlay draw pass", () => {
  it("no selection → no border cells (the pad cols stay clean)", () => {
    const r = make(80, 24)
    draw(baseState(seedA()), r)
    expect(cellAt(r, 4, 2).text).toBe(" ")
    expect(cellAt(r, 76, 2).text).toBe(" ")
  })

  it("flash-visible box: ┌✗ top row (dashes), │ sides, └┘ bottom — no re-layout", () => {
    const e = seedA()
    const app = baseState(e)
    e.setSelection(0, 2)
    app.selectionFlashUntil = 1e12 // flash phase (frozen-clock proof)
    const r = make(80, 24)
    draw(app, r)
    // rows: lines 0..2 at screen rows 2..4 (off 0), box cols left=4 right=76.
    expect(cellAt(r, 4, 2).text).toBe("┌")
    expect(cellAt(r, 76, 2).text).toBe("✗")
    expect(cellAt(r, 10, 2).text).toBe("─") // top dash overlays the selected row
    expect(cellAt(r, 4, 3).text).toBe("│")
    expect(cellAt(r, 76, 3).text).toBe("│")
    expect(cellAt(r, 4, 4).text).toBe("└")
    expect(cellAt(r, 76, 4).text).toBe("┘")
    // No re-layout: the row's own runs keep their cells (line 1 text intact).
    expect(cellAt(r, 6, 3).text).toBe("t")
    expect(cellAt(r, 10, 3).text).toBe("l")
  })

  it("hold mode persists after the flash (the selection stays — box drawn)", () => {
    const e = seedA()
    const app = baseState(e, { keepTextSelection: "hold" })
    e.setSelection(1, 2)
    app.selectionFlashUntil = 0 // flash over — hold keeps the state
    const r = make(80, 24)
    draw(app, r)
    expect(cellAt(r, 4, 3).text).toBe("┌")
    expect(cellAt(r, 76, 3).text).toBe("✗")
    expect(cellAt(r, 4, 4).text).toBe("└")
    expect(cellAt(r, 76, 4).text).toBe("┘")
  })

  it("word_select single-row: corners only (no dashes — the row text stays)", () => {
    const e = seedA()
    const app = baseState(e, { keepTextSelection: "word_select" })
    e.setSelection(1, 1)
    const r = make(80, 24)
    draw(app, r)
    const row = 3 // line 1 → screen row 3 (off 0)
    expect(cellAt(r, 4, row).text).toBe("┌")
    expect(cellAt(r, 76, row).text).toBe("✗")
    expect(cellAt(r, 10, row).text).toBe("l") // "two lines" intact — no dash
  })

  it("clip-top: the span starts above the viewport → the top rows read ┆ (no corners)", () => {
    const e = seedC()
    const app = baseState(e, { scroll: { offset: 5, follow: false } })
    e.setSelection(0, 15)
    const r = make(80, 24)
    draw(app, r)
    // visible slice lines 5..15 → rows 2..12; line 5's row (2) is clipped above.
    expect(cellAt(r, 4, 2).text).toBe("┆")
    expect(cellAt(r, 76, 2).text).toBe("┆")
    // the bottom (line 15 < off+h-1=17) keeps its corners at row 12.
    expect(cellAt(r, 4, 12).text).toBe("└")
    expect(cellAt(r, 76, 12).text).toBe("┘")
  })

  it("clip-bottom: the span runs off the viewport bottom → the last row reads ┆", () => {
    const e = seedC()
    const app = baseState(e, { scroll: { offset: 0, follow: false } })
    e.setSelection(1, 99) // engine clamps to line 24; the span reaches the view edge
    const r = make(80, 24)
    draw(app, r)
    // bottom visible row = 14 (off 0, h 13 → lines 0..12; b clamped 24).
    expect(cellAt(r, 4, 14).text).toBe("┆")
    expect(cellAt(r, 76, 14).text).toBe("┆")
    // the top (not clipped) keeps the corner + ✗.
    expect(cellAt(r, 4, 3).text).toBe("┌")
    expect(cellAt(r, 76, 3).text).toBe("✗")
  })

  it("drag tape: the pointer row's left border reads ▏ while the drag is open", () => {
    const e = seedA()
    const app = baseState(e)
    e.setSelection(0, 2)
    app.selectionDragLine = 1 // the pointer sits on line 1 during the drag
    const r = make(80, 24)
    draw(app, r)
    expect(cellAt(r, 4, 3).text).toBe("▏") // tape replaces the left border
    expect(cellAt(r, 4, 2).text).toBe("┌") // the anchor row keeps its corner
    expect(cellAt(r, 76, 3).text).toBe("│")
  })

  it("timeline-on box: the right border steps 1 column left of the rail", () => {
    const e = seedA()
    const app = baseState(e, { showTimeline: true })
    e.setSelection(0, 2)
    const r = make(80, 24)
    draw(app, r)
    // seedA has ONE turn — the gate requires 2 → the box keeps the default
    // right column (76) and no rail draws.
    expect(cellAt(r, 76, 2).text).toBe("✗")
    // TWO turns → the stepped border + the rail side by side.
    const e2 = seedB()
    const app2 = baseState(e2, { showTimeline: true })
    e2.setSelection(0, 2)
    const r2 = make(80, 24)
    draw(app2, r2)
    expect(cellAt(r2, 74, 2).text).toBe("✗")
    expect(cellAt(r2, 74, 4).text).toBe("┘")
    expect(cellAt(r2, 76, 2).text).toBe("▴") // the rail owns 76/77
  })
})

describe("timeline rail (M46c G1)", () => {
  it("gate: needs showTimeline + pane width >= 60 + turns >= 2", () => {
    const e = seedB()
    expect(anchorsOf(e).length).toBe(2)
    const rect = { x: 2, y: 2, w: 76, h: 13 }
    expect(timelineActive(baseState(e), rect, e)).toBe(false) // showTimeline off
    expect(timelineActive(baseState(e, { showTimeline: true }), rect, e)).toBe(true)
    expect(timelineActive(baseState(e, { showTimeline: true }), { x: 2, y: 2, w: 59, h: 13 }, e)).toBe(false) // width
    const single = seedA() // 1 turn
    expect(timelineActive(baseState(single, { showTimeline: true }), rect, single)).toBe(false)
  })

  it("draws ▴/▾ chevrons + the active `━━` tick + idle ` ─` for the other turn", () => {
    const e = seedB() // anchors line 0 (hello) + line 10 (again); off 0; h 13
    const app = baseState(e, { showTimeline: true })
    const r = make(80, 24)
    draw(app, r)
    expect(cellAt(r, 76, 2).text).toBe("▴") // top end (prev exists: active=1)
    expect(cellAt(r, 77, 2).text).toBe(" ")
    expect(cellAt(r, 76, 12).text).toBe("━") // active tick (turn 2 = viewport bottom)
    expect(cellAt(r, 77, 12).text).toBe("━")
    expect(cellAt(r, 76, 14).text).toBe("▾") // bottom end (next: none → still drawn)
    // the second turn's tick is OFFSCREEN (line 0 < off) — idle ticks: an
    // invisible anchor draws nothing. The 76/77 columns elsewhere stay blank.
    expect(cellAt(r, 76, 6).text).toBe(" ")
    expect(cellAt(r, 77, 6).text).toBe(" ")
  })

  it("hover over a tick: ⟵ idles then the hover state flips it to `──` + the popup card", () => {
    const e = seedB()
    const app = baseState(e, { showTimeline: true })
    app.mouse = { enabled: true, last: { col: 0, row: 0 }, hovered: new Set(), engine: new HoverEngine() }
    const r = make(80, 24)
    draw(app, r) // frame 1: registers the areas, settles (0,0) → no hover
    // Move the pointer over the ACTIVE tick row (col 76, row 12).
    app.mouse = { ...app.mouse, last: { col: 76, row: 12 } }
    draw(app, r) // frame 2: registers + settles the NEW hovered set
    draw(app, r) // frame 3: the settled tl-tick-1 flips the glyph + popup
    expect(cellAt(r, 76, 12).text).toBe("─")
    expect(cellAt(r, 77, 12).text).toBe("─")
    // The popup card: 21 cols flush left of the rail at the tick row: the
    // preview "again" right-aligned (col 71..75), the card pad at 55.
    expect(cellAt(r, 55, 12).text).toBe(" ")
    expect(cellAt(r, 75, 12).text).toBe("n")
    expect(cellAt(r, 71, 12).text).toBe("a")
    expect(app.mouse.hovered.has("tl-tick-1")).toBe(true)
  })

  it("active resolution: bottom-line rule — a follow view at the tail marks the newest turn", () => {
    const anchors = [{ lineIndex: 0 }, { lineIndex: 10 }]
    expect(activeTurnIndex(anchors, 12)).toBe(1)
    expect(activeTurnIndex(anchors, 5)).toBe(0)
    expect(activeTurnIndex(anchors, 0)).toBe(0)
  })

  it("hover a chevron → textPrimary (idle gray)", () => {
    const e = seedB()
    const app = baseState(e, { showTimeline: true })
    app.mouse = { enabled: true, last: { col: 0, row: 0 }, hovered: new Set(), engine: new HoverEngine() }
    const r = make(80, 24)
    draw(app, r)
    app.mouse = { ...app.mouse, last: { col: 76, row: 2 } }
    draw(app, r)
    draw(app, r) // the settled hover (frame 2) paints on frame 3
    expect(cellAt(r, 76, 2).text).toBe("▴")
    expect(cellAt(r, 76, 2).style["fg"]).toEqual({ r: 0xe1, g: 0xe1, b: 0xe1 }) // textPrimary
  })

  it("renderTimelineRail drops the wheel/scrollbar column — the rail writes only 76..77", () => {
    const e = seedB()
    const app = baseState(e, { showTimeline: true })
    const r = make(80, 24)
    draw(app, r)
    // 78/79 (the outer frame pad) stay terminal-clean.
    let dirty = 0
    for (let y = 2; y < 14; y++) {
      if (cellAt(r, 78, y).text !== " ") dirty++
      if (cellAt(r, 79, y).text !== " ") dirty++
    }
    expect(dirty).toBe(0)
  })
})

describe("timeline mouse routing (M46c G1)", () => {
  interface HookRig {
    app: TuiAppState
    engine: ScrollbackEngine
    router: MouseRouter
    jumps: number[]
    sb: Rect
  }

  const hookRig = (showTimeline: boolean): HookRig => {
    const e = seedB()
    const app = baseState(e, { showTimeline })
    const jumps: number[] = []
    const hooks: MouseHooks = { timelineJump: (line) => jumps.push(line) }
    const router = new MouseRouter({
      app,
      engine: e,
      size: () => ({ cols: 80, rows: 24 }),
      now: () => 0,
      clipboard: { copy: () => {} },
      glyphs: GLYPHS,
      compact: false,
      hooks,
    })
    const sb = layoutAgent({ cols: 80, rows: 24 }, { ...app, dropdown: undefined }, { compact: false }).scrollback
    return { app, engine: e, router, jumps, sb }
  }

  const click = (r: { router: MouseRouter }, x: number, y: number): void => {
    r.router.handle({ x, y, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    r.router.handle({ x, y, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
  }

  it("tick click jumps to the anchor line via the /jump goTo seam", () => {
    const r = hookRig(true)
    click(r, 76, 12) // the active tick row (anchor line 10)
    expect(r.jumps).toEqual([10])
  })

  it("top chevron = previous turn; bottom = next (relative to the active view)", () => {
    const e = seedD() // anchors 0/10/20: at off 0 (h 13) the active = turn 2
    const app = baseState(e, { showTimeline: true })
    const jumps: number[] = []
    const router = new MouseRouter({
      app,
      engine: e,
      size: () => ({ cols: 80, rows: 24 }),
      now: () => 0,
      clipboard: { copy: () => {} },
      glyphs: GLYPHS,
      compact: false,
      hooks: { timelineJump: (line) => jumps.push(line) },
    })
    const r = { app, router, jumps }
    r.app.scroll = { offset: 0, follow: false } // pin the viewport at the top
    click(r, 76, 2) // ▴ → previous turn (anchor line 0)
    expect(r.jumps).toEqual([0])
    click(r, 76, 14) // ▾ → the NEXT turn (anchor line 19)
    expect(r.jumps).toEqual([0, 19])
    // at the LAST turn (scrolled to the tail) the ▾ is a no-op — no jump.
    r.app.scroll = { offset: 24, follow: false }
    click(r, 76, 14)
    expect(r.jumps).toEqual([0, 19])
  })

  it("rail ON suppresses the scrollbar latch for the right 2 columns", () => {
    const r = hookRig(true)
    // A rail column with no tick → no jump, no latch (motion after the down
    // would jumpToFraction if latched).
    click(r, 76, 6)
    expect(r.app.scroll.offset).toBe(0)
    expect(r.app.scroll.follow).toBe(true)
    // OFF → the same column latches (the classic scrollbar down).
    const r2 = hookRig(false)
    click(r2, 77, 6)
    expect(r2.app.scroll.follow).toBe(false) // fraction jump fired
  })

  it("✗ cell click clears the selection (flash+hold+word_select states)", () => {
    const r = hookRig(false)
    r.engine.setSelection(0, 2)
    click(r, 76, 2) // the top-right ✗ cell (row = sb.y + (0 - off))
    expect(r.engine.selection()).toBeUndefined()
    // a click on a NON-✗ border cell keeps the selection (the standard entry).
    r.engine.setSelection(0, 2)
    click(r, 76, 3)
    expect(r.engine.selection()).not.toBeUndefined()
  })

  it("drag mirrors selectionDragLine (the tape state) and clears on release", () => {
    const r = hookRig(false)
    r.router.handle({ x: 30, y: 4, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    r.router.handle({ x: 31, y: 6, button: "left", kind: "motion", drag: true, mods: { ctrl: false, shift: false, alt: false } })
    expect(r.app.selectionDragLine).toBe(4) // sb.y=2, off 0 → line 4 (the pointer row)
    r.router.handle({ x: 31, y: 6, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(r.app.selectionDragLine).toBeUndefined()
    expect(r.engine.selection()).toEqual({ a: 2, b: 4 })
  })
})

describe("engine.turnAnchors (M46c G1) — O(turns) accessor", () => {
  it("one entry per user block: the header display line + strip-prefixed preview", () => {
    const e = seedB()
    const anchors = anchorsOf(e)
    expect(anchors).toEqual([
      { lineIndex: 0, preview: "hello" },
      { lineIndex: 10, preview: "again" }, // 1+2+7 display lines before the user
    ])
  })

  it("matches the /jump lineBlock walk (parity — same set, same order)", () => {
    const e = seedB()
    const total = e.lineCount()
    const walk: number[] = []
    for (let line = 0; line < total; line++) {
      const b = e.lineBlock(line)
      if (b?.title === "User") walk.push(line)
    }
    expect(anchorsOf(e).map((a) => a.lineIndex)).toEqual(walk)
  })

  it("folding shifts the anchors (an interleaved edit expands/collapses rows)", () => {
    const e = createScrollbackEngine({ width: 80 })
    push(e, { type: "user", text: "hello", ts: 100 })
    push(e, { type: "assistant", text: "two lines\nthird line", ts: 200 })
    push(e, {
      type: "tool", callId: "e1", name: "patch.txt", kind: "edit", status: "done",
      output: "+a1\n+a2\n+a3\n+a4\n+a5\n+a6\n-b1\n-b2\n-b3\n-b4\n-b5\n-b6", summary: "patch.txt", ts: 300,
    })
    push(e, { type: "user", text: "again", ts: 400 })
    push(e, { type: "assistant", text: "tail", ts: 500 })
    const before = anchorsOf(e)[1]!.lineIndex
    expect(before).toBe(16) // the expanded edit sits before turn 2
    e.toggleFoldAt(3) // the edit header → collapsed (one delta header row)
    const after = anchorsOf(e)[1]!.lineIndex
    expect(after).toBe(4) // 1 + 2 + 1 rows before the second user
  })
})
