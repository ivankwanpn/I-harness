// M46b G2: mouse click semantics — the dispatch core (app/mouse.ts) against a
// FAKE app state + a REAL engine + an injected clipboard (dry-run level: the
// router is exercised directly; no loop, no terminals).
// One test per listed behavior (spec delta §3, M46b design §3 G2).

import { describe, expect, it, vi } from "vitest"
import { GLYPHS } from "@i-harness/tui-core"
import type { GlyphSet } from "@i-harness/tui-core"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import type { ScrollbackEngine, TuiEvent } from "../src/contracts.ts"
import { MouseRouter, pasteChipAt, fileRefAt, dropdownTotal } from "../src/app/mouse.ts"
import { bindPermissionOverlay, bindQuestionOverlay, bindCancelTurnOverlay } from "../src/app/overlay-seam.ts"
import type { TuiAppState } from "../src/app/present.ts"
import { layoutAgent } from "../src/views/agent.ts"
import type { Rect } from "../src/views/agent.ts"

export interface RecordingClipboard {
  copied: string[]
  copy(text: string): void
}

const makeClipboard = (): RecordingClipboard => {
  const copied: string[] = []
  return { copied, copy: (t) => copied.push(t) }
}

const AREA = { cols: 100, rows: 24 }

const base = (engine: ScrollbackEngine, partial: Partial<TuiAppState> = {}): TuiAppState => ({
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
    branch: undefined, path: "~/proj", tickMs: 0, model: "mock-model", plan: false,
    contextUsed: undefined, contextTotal: undefined,
    todo: { done: 0, total: 0 }, tasks: { running: 0, labels: [] }, queue: 0, mcp: null,
  },
  turn: undefined,
  toasts: [],
  panes: new Set<string>(),
  shortcuts: { items: [] },
  ...partial,
})

interface Rig {
  app: TuiAppState
  engine: ScrollbackEngine
  router: MouseRouter
  clipboard: RecordingClipboard
  toasts(): string[]
  sb: Rect
  layout(): ReturnType<typeof layoutAgent>
}

function rig(engine: ScrollbackEngine, partial: Partial<TuiAppState> = {}, glyphs: GlyphSet = GLYPHS): Rig {
  let t = 0
  const app = base(engine, partial)
  const clipboard = makeClipboard()
  const router = new MouseRouter({
    app,
    engine,
    size: () => AREA,
    now: () => t,
    clipboard,
    glyphs,
    compact: false,
    hooks: {
      focus: (target) => { app.focused = target },
      onChanged: () => { void 0 },
    },
  })
  const layout = (): ReturnType<typeof layoutAgent> =>
    layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false })
  const sb = layout().scrollback
  return {
    app, engine, router, clipboard, sb,
    toasts: () => app.toasts.map((x) => x.text),
    layout,
  }
}

/** down+up at a cell (the parser's click). */
const click = (r: Rig, x: number, y: number, ctrl = false): void => {
  r.router.handle({ x, y, button: "left", kind: "down", drag: false, mods: { ctrl, shift: false, alt: false } })
  r.router.handle({ x, y, button: "left", kind: "up", drag: false, mods: { ctrl, shift: false, alt: false } })
}

/** down+up via a raw router (tests with custom routers). */
const clickAt = (router: MouseRouter, x: number, y: number): void => {
  router.handle({ x, y, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
  router.handle({ x, y, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
}

/** A second click within the multi-click window (simulated time gap). */
const click2 = (r: Rig, x: number, y: number, gapMs = 100, ctrl = false): void => {
  // The router's clock is fixed at 0 in rig(); the window test advances a
  // fake clock via `now` — see timedRig below.
  void gapMs
  click(r, x, y, ctrl)
}

/** Down → motion(drag) → up (a ≥1-cell drag). */
const drag = (r: Rig, x0: number, y0: number, x1: number, y1: number): void => {
  r.router.handle({ x: x0, y: y0, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
  r.router.handle({ x: x1, y: y1, button: "left", kind: "motion", drag: true, mods: { ctrl: false, shift: false, alt: false } })
  r.router.handle({ x: x1, y: y1, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
}

const seeded = (): ScrollbackEngine => {
  const e = createScrollbackEngine({ width: 80 })
  const seq = { n: 0 }
  const push = (ev: { type: string } & Record<string, unknown>): void => {
    seq.n++
    e.append({ ...ev, seq: seq.n, ts: (ev.ts as number | undefined) ?? seq.n * 10 } as unknown as TuiEvent)
  }
  push({ type: "user", text: "hello" })
  push({ type: "assistant", text: "world\n" })
  push({ type: "tool", callId: "c1", name: "apply", kind: "edit", status: "done", summary: "patch", output: "+a\n-b" })
  return e
}

/** A timed rig — the router's now() advances by the fakeTime steps. */
function timedRig(engine: ScrollbackEngine, partial: Partial<TuiAppState> = {}): Rig & { at(m: number): void } {
  let t = 0
  const app = base(engine, partial)
  const clipboard = makeClipboard()
  const router = new MouseRouter({
    app, engine, size: () => AREA, now: () => t, clipboard, glyphs: GLYPHS, compact: false,
    hooks: { focus: (target) => { app.focused = target } },
  })
  const layout = (): ReturnType<typeof layoutAgent> =>
    layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false })
  return {
    app, engine, router, clipboard, sb: layout().scrollback,
    toasts: () => app.toasts.map((x) => x.text),
    layout,
    at: (m) => { t = m },
  }
}

describe("scrollback — click semantics", () => {
  it("single click: select the entry + focus the scrollback", () => {
    const engine = seeded()
    const r = rig(engine)
    const row = r.sb.y + 1 // second display row
    click(r, r.sb.x + 10, row)
    expect(r.engine.selection()).toEqual({ a: 1, b: 1 })
    expect(r.app.focused).toBe("scrollback")
  })

  it("double click ≤300ms on a collapsible block: fold toggle", () => {
    const engine = seeded()
    const before = engine.lineCount()
    const r = rig(engine)
    // The edit tool block header (expanded-by-default, collapsible) is the
    // 4th display row (user 1 + assistant wrap 2 = lines 0..2; edit at 3).
    const row = r.sb.y + 3
    click(r, r.sb.x + 10, row)
    click2(r, r.sb.x + 10, row)
    expect(engine.lineCount()).toBeLessThan(before) // expanded → collapsed
  })

  it("triple click: fold + scroll-to-top", () => {
    const engine = seeded()
    const r = timedRig(engine)
    r.at(0)
    const row = r.sb.y + 2
    click(r, r.sb.x + 10, row)
    r.at(100)
    click(r, r.sb.x + 10, row)
    r.at(200)
    click(r, r.sb.x + 10, row)
    expect(r.app.scroll).toEqual({ offset: 0, follow: false })
  })

  it("double click on a bg-task/subagent entry: viewer absent → honest toast", () => {
    const engine = createScrollbackEngine({ width: 80 })
    engine.append({ type: "tool", callId: "s1", name: "spawn", kind: "subagent", status: "running", summary: "worker", seq: 1, ts: 0 })
    const r = rig(engine)
    const row = r.sb.y + 1
    click(r, r.sb.x + 10, row)
    click2(r, r.sb.x + 10, row)
    expect(r.toasts()).toContain("viewer (M46c)")
  })

  it("multi-click window: a click after ≥300ms is a NEW single click (no fold)", () => {
    const engine = seeded()
    const before = engine.lineCount()
    const r = timedRig(engine)
    r.at(0)
    click(r, r.sb.x + 10, r.sb.y + 2)
    r.at(400) // outside the 300ms window
    click(r, r.sb.x + 10, r.sb.y + 2)
    expect(engine.lineCount()).toBe(before) // no fold — the old gesture expired
  })
})

describe("keep_text_selection=word_select — 1/2/3 click cycle", () => {
  it("1 = select entry; 2 = word select + copy immediate + toast; 3 = paragraph", () => {
    const engine = createScrollbackEngine({ width: 80 })
    engine.append({ type: "assistant", text: "see https://example.com/docs now\n", seq: 1, ts: 0 })
    engine.append({ type: "system", text: "gap\n", seq: 2, ts: 0 })
    engine.append({ type: "assistant", text: "alpha beta gamma\n", seq: 3, ts: 0 })
    const r = timedRig(engine, { keepTextSelection: "word_select", scroll: { offset: 0, follow: false } })
    const row = r.sb.y // first display row
    // textStart = x + RAIL(1) + PAD(2) + 1; the URL starts 4 cols in ("see ").
    const urlCell = r.sb.x + 5 + 4
    // 1st click — select the entry.
    r.at(0)
    click(r, urlCell, row)
    expect(r.engine.selection()).toEqual({ a: 0, b: 0 })
    // 2nd click — word/URL select + COPY IMMEDIATE.
    r.at(100)
    click(r, urlCell, row)
    expect(r.clipboard.copied.length).toBeGreaterThan(0)
    expect(r.clipboard.copied[0]).toContain("https://")
    expect(r.toasts()).toContain("Copied!")
  })

  it("3rd click — paragraph selection around the click (blank-line delimited)", () => {
    const engine = createScrollbackEngine({ width: 80 })
    engine.append({ type: "system", text: "\n", seq: 1, ts: 0 })
    engine.append({ type: "assistant", text: "para line one\n", seq: 2, ts: 0 })
    engine.append({ type: "assistant", text: "para line two\n", seq: 3, ts: 0 })
    engine.append({ type: "system", text: "\n", seq: 4, ts: 0 })
    const r = timedRig(engine, { keepTextSelection: "word_select", scroll: { offset: 0, follow: false } })
    // layout: 0:"", 1:"", 2:para-line-one, 3:para-line-two, 4:"" ...
    const row = r.sb.y + 2
    r.at(0); click(r, r.sb.x + 6, row)
    r.at(100); click(r, r.sb.x + 6, row)
    r.at(200); click(r, r.sb.x + 6, row)
    const sel = r.engine.selection()
    expect(sel).toBeDefined()
    expect(sel!.a).toBeLessThanOrEqual(2)
    expect(sel!.b).toBeGreaterThanOrEqual(3)
  })
})

describe("drag — selection + autoscroll + auto-copy + flash (knob modes)", () => {
  it("≥1 cell drag selects display lines, auto-copies on up, toasts + flash", () => {
    const engine = createScrollbackEngine({ width: 80 })
    for (let i = 0; i < 6; i++) engine.append({ type: "assistant", text: `line ${i}\n`, seq: i + 1, ts: 0 })
    const r = timedRig(engine)
    r.at(0)
    const row0 = r.sb.y
    const row2 = r.sb.y + 2
    drag(r, r.sb.x + 5, row0, r.sb.x + 6, row2)
    const sel = r.engine.selection()!
    expect(Math.abs(sel.a - sel.b)).toBeGreaterThanOrEqual(2)
    expect(r.clipboard.copied.length).toBe(1)
    expect(r.clipboard.copied[0]).toContain("line 0")
    expect(r.toasts()).toContain("Copied!")
    expect(r.app.selectionFlashUntil).toBeGreaterThan(0)
  })

  it("autoscroll: pointer within the edge band scrolls 5 rows per tick (distance 0)", () => {
    const engine = createScrollbackEngine({ width: 80 })
    for (let i = 0; i < 40; i++) engine.append({ type: "assistant", text: `row ${i}\n`, seq: i + 1, ts: 0 })
    // Scroll AWAY from the tail first — a drag at the tail has no bottom room.
    const r = timedRig(engine, { scroll: { offset: 10, follow: false } })
    r.at(0)
    const bottom = r.sb.y + r.sb.h - 1
    r.router.handle({ x: r.sb.x + 5, y: bottom, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    // motion 1 col right, still on the LAST row — the 0-distance band.
    r.router.handle({ x: r.sb.x + 6, y: bottom, button: "left", kind: "motion", drag: true, mods: { ctrl: false, shift: false, alt: false } })
    const before = r.app.scroll.offset
    expect(before).toBe(10)
    r.router.frame(16)
    expect(r.app.scroll.offset).toBe(before + 5)
    expect(r.app.scroll.follow).toBe(false)
  })

  it("autoscroll distance band 1 → 3 rows per tick", () => {
    const engine = createScrollbackEngine({ width: 80 })
    for (let i = 0; i < 40; i++) engine.append({ type: "assistant", text: `row ${i}\n`, seq: i + 1, ts: 0 })
    const r = timedRig(engine, { scroll: { offset: 10, follow: false } })
    r.at(0)
    const oneAbove = r.sb.y + r.sb.h - 2 // 1 row from the bottom edge
    r.router.handle({ x: r.sb.x + 5, y: oneAbove, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    r.router.handle({ x: r.sb.x + 6, y: oneAbove, button: "left", kind: "motion", drag: true, mods: { ctrl: false, shift: false, alt: false } })
    const before = r.app.scroll.offset
    r.router.frame(16)
    expect(r.app.scroll.offset).toBe(before + 3)
  })

  it("lost-up recovery: motion without the button (release lost) still copies", () => {
    const engine = createScrollbackEngine({ width: 80 })
    for (let i = 0; i < 6; i++) engine.append({ type: "assistant", text: `line ${i}\n`, seq: i + 1, ts: 0 })
    const r = timedRig(engine)
    r.at(0)
    r.router.handle({ x: r.sb.x + 5, y: r.sb.y, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    r.router.handle({ x: r.sb.x + 6, y: r.sb.y + 2, button: "left", kind: "motion", drag: true, mods: { ctrl: false, shift: false, alt: false } })
    // the button-up was LOST — a no-button motion arrives instead (drag=false).
    r.router.handle({ x: r.sb.x + 6, y: r.sb.y + 2, button: "left", kind: "motion", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(r.clipboard.copied.length).toBe(1)
    expect(r.toasts()).toContain("Copied!")
  })

  it("flash expiry: flash mode clears the selection after 150ms; hold keeps it", () => {
    const engine = createScrollbackEngine({ width: 80 })
    for (let i = 0; i < 5; i++) engine.append({ type: "assistant", text: `line ${i}\n`, seq: i + 1, ts: 0 })
    const r = timedRig(engine, { keepTextSelection: "flash" })
    r.at(0)
    drag(r, r.sb.x + 5, r.sb.y, r.sb.x + 6, r.sb.y + 1)
    expect(r.engine.selection()).toBeDefined()
    r.router.frame(160)
    expect(r.engine.selection()).toBeUndefined() // flash: selection dropped
    // hold mode stays.
    const e2 = createScrollbackEngine({ width: 80 })
    for (let i = 0; i < 5; i++) e2.append({ type: "assistant", text: `line ${i}\n`, seq: i + 1, ts: 0 })
    const r2 = timedRig(e2, { keepTextSelection: "hold" })
    drag(r2, r2.sb.x + 5, r2.sb.y, r2.sb.x + 6, r2.sb.y + 1)
    r2.router.frame(10_000)
    expect(r2.engine.selection()).toBeDefined() // hold persists
  })
})

describe("scrollbar column — latch + jump", () => {
  const scrollbarEngine = (): ScrollbackEngine => {
    const engine = createScrollbackEngine({ width: 80 })
    for (let i = 0; i < 80; i++) engine.append({ type: "assistant", text: `row ${i}\n`, seq: i + 1, ts: 0 })
    return engine
  }

  it("down at the bottom row → offset = max (follow off)", () => {
    const engine = scrollbarEngine()
    const r = timedRig(engine)
    const sb = r.sb
    const bottom = sb.y + sb.h - 1
    r.at(0)
    click(r, sb.x + sb.w - 1, bottom)
    const max = Math.max(0, engine.lineCount() - sb.h + 1)
    expect(r.app.scroll).toEqual({ offset: max, follow: false })
  })

  it("down at the top row → offset 0; motion mid → proportional; up ends", () => {
    const engine = scrollbarEngine()
    const r = timedRig(engine)
    r.at(0)
    click(r, r.sb.x + r.sb.w - 1, r.sb.y)
    expect(r.app.scroll.offset).toBe(0)
    // latch + drag to the middle.
    r.app.scroll = { offset: 0, follow: true }
    r.router.handle({ x: r.sb.x + r.sb.w - 1, y: r.sb.y, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    const midY = r.sb.y + Math.floor(r.sb.h / 2)
    r.router.handle({ x: r.sb.x + r.sb.w - 1, y: midY, button: "left", kind: "motion", drag: true, mods: { ctrl: false, shift: false, alt: false } })
    expect(r.app.scroll.offset).toBeGreaterThan(0)
    const mid = r.app.scroll.offset
    // up ends the latch — further motion leaves the offset.
    r.router.handle({ x: r.sb.x + r.sb.w - 1, y: midY, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    r.router.handle({ x: r.sb.x + r.sb.w - 1, y: r.sb.y, button: "left", kind: "motion", drag: true, mods: { ctrl: false, shift: false, alt: false } })
    expect(r.app.scroll.offset).toBe(mid)
  })
})

describe("prompt — click / file-ref / paste chip / drag", () => {
  it("click sets the cursor at the approximate cell column", () => {
    const engine = seeded()
    const r = rig(engine, { prompt: { text: "hello world", cursor: 0, multiLine: false, focused: true, model: "m", plan: false, title: "t" } })
    const p = r.layout().prompt
    const row = p.y + 1 // first content row
    click(r, p.x + 4, row) // inside "hello" (text starts x+1+2)
    expect(r.app.prompt.cursor).toBeGreaterThanOrEqual(1)
    expect(r.app.prompt.cursor).toBeLessThanOrEqual(6)
  })

  it("double-click on a file ref opens the (absent) line viewer → toast", () => {
    const engine = seeded()
    const text = "see src/app/mouse.ts:42 please"
    const r = timedRig(engine, { prompt: { text, cursor: 0, multiLine: false, focused: true, model: "m", plan: false, title: "t" } })
    const p = r.layout().prompt
    const row = p.y + 1
    const col = p.x + 1 + 2 + text.indexOf("src/app/mouse.ts") + 1
    r.at(0); click(r, col, row)
    r.at(100); click(r, col, row)
    expect(r.toasts().some((t) => t.includes("line viewer"))).toBe(true)
  })

  it("double-click on a [Pasted: N lines] chip → honest toast (source not retained)", () => {
    const engine = seeded()
    const text = "[Pasted: 5 lines] big blob"
    const r = timedRig(engine, { prompt: { text, cursor: 0, multiLine: false, focused: true, model: "m", plan: false, title: "t" } })
    const p = r.layout().prompt
    const row = p.y + 1
    const col = p.x + 1 + 2 + text.indexOf("[Pasted:") + 2
    r.at(0); click(r, col, row)
    r.at(100); click(r, col, row)
    expect(r.toasts().some((t) => t.includes("paste chip"))).toBe(true)
  })

  it("prompt drag = text selection + copy on up", () => {
    const engine = seeded()
    const text = "select me please"
    const r = timedRig(engine, { prompt: { text, cursor: 0, multiLine: false, focused: true, model: "m", plan: false, title: "t" } })
    const p = r.layout().prompt
    const row = p.y + 1
    drag(r, p.x + 3, row, p.x + 9, row)
    expect(r.clipboard.copied.length).toBe(1)
    expect(r.clipboard.copied[0].length).toBeGreaterThan(0)
  })
})

describe("overlays — permission / question / cancel-turn", () => {
  it("permission: single click = active row; double (≤300ms same index) fires", () => {
    const engine = seeded()
    const surf = { id: "p1", kind: "edit" as const, title: "Allow Edit?", detail: "apply patch", freeform: false, scopes: ["/a"] }
    const state = { cursor: 0, scopeIndex: 0, freeformText: "" }
    const decisions: unknown[] = []
    const closed = { n: 0 }
    const seam = bindPermissionOverlay(surf, state, {
      onDecision: (d) => decisions.push(d),
      onClose: () => { closed.n++ },
    })
    const app = base(engine, { overlay: seam })
    const clipboard = makeClipboard()
    let t = 0
    const router = new MouseRouter({
      app, engine, size: () => AREA, now: () => t, clipboard, glyphs: GLYPHS, compact: false,
      hooks: { focus: (tg) => { app.focused = tg } },
    })
    const p = layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false }).prompt
    const rows = seam.rowYs!(p)
    // single click on row 2 (Yes, proceed).
    const row2 = rows[2]!
    router.handle({ x: p.x + 5, y: row2, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    router.handle({ x: p.x + 5, y: row2, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(state.cursor).toBe(2)
    expect(decisions).toHaveLength(0) // single: cursor only
    t += 100
    router.handle({ x: p.x + 5, y: row2, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    router.handle({ x: p.x + 5, y: row2, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(decisions).toHaveLength(1) // double: fires (Yes, proceed — once)
    expect(decisions[0]).toMatchObject({ surfaceId: "p1", verdict: "once", approved: true })
    expect(closed.n).toBe(1) // decide() closes the overlay
  })

  it("question (multi): single click toggles; double answers", () => {
    const engine = seeded()
    const q = {
      id: "q1", label: "Pick tools?", description: "",
      options: [
        { key: "1", label: "bash" },
        { key: "2", label: "read" },
      ],
      multi: true, freeform: false,
    }
    const state = { page: 1, pages: 1, cursor: 0, selected: [] as string[], freeformFocused: false, freeformText: "" }
    const decisions: unknown[] = []
    const seam = bindQuestionOverlay(q, state, { onDecision: (d) => decisions.push(d), onClose: () => { void 0 } })
    const app = base(engine, { overlay: seam })
    const clipboard = makeClipboard()
    let t = 0
    const router = new MouseRouter({ app, engine, size: () => AREA, now: () => t, clipboard, glyphs: GLYPHS, compact: false, hooks: {} })
    const p = layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false }).prompt
    const rows = seam.rowYs!(p)
    const row0 = rows[0]!
    const cell = { x: p.x + 5, y: row0, button: "left" as const, drag: false, mods: { ctrl: false, shift: false, alt: false } }
    router.handle({ ...cell, kind: "down" })
    router.handle({ ...cell, kind: "up" })
    expect(state.selected).toEqual(["1"]) // toggle
    t += 100
    router.handle({ ...cell, kind: "down" })
    router.handle({ ...cell, kind: "up" })
    expect(decisions).toHaveLength(1) // double: answers the question
  })

  it("cancel-turn: a click fires the choice", () => {
    const engine = seeded()
    const state = { count: 2, cursor: 0 }
    const decisions: unknown[] = []
    const seam = bindCancelTurnOverlay(state, { onDecision: (d) => decisions.push(d), onClose: () => { void 0 } })
    const app = base(engine, { overlay: seam })
    const clipboard = makeClipboard()
    const router = new MouseRouter({ app, engine, size: () => AREA, now: () => 0, clipboard, glyphs: GLYPHS, compact: false, hooks: {} })
    const p = layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false }).prompt
    const rows = seam.rowYs!(p)
    const row1 = rows[1]!
    router.handle({ x: p.x + 5, y: row1, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    router.handle({ x: p.x + 5, y: row1, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ index: 1, label: "Continue to run" })
  })
})

describe("status chips", () => {
  const statusful = (): ScrollbackEngine => {
    const e = createScrollbackEngine({ width: 80 })
    e.append({ type: "user", text: "hello", seq: 1, ts: 0 })
    return e
  }

  it("cwd click → clipboard copy of the path", () => {
    const engine = statusful()
    const r = rig(engine, { status: { path: "~/myproj", tickMs: 0, model: "m", plan: false, todo: { done: 0, total: 0 }, tasks: { running: 0, labels: [] }, queue: 0, mcp: null } })
    const st = r.layout().status
    const span = 1 + 0 + 2 // icon(1) + no branch + "  " prefix (2)
    click(r, st.x + span + 2, st.y)
    expect(r.clipboard.copied).toEqual(["~/myproj"])
  })

  it("tasks chip → pane toggle", () => {
    const engine = statusful()
    const r = rig(engine, {
      status: { path: "~/p", tickMs: 0, model: "m", plan: false, todo: { done: 0, total: 0 }, tasks: { running: 2, labels: [] }, queue: 0, mcp: null },
      paneData: { tasks: [{ label: "Subagents", entries: [] }] },
    })
    const st = r.layout().status
    // The ONLY right chip here is `⠋ 2` (4 cols, right-anchored).
    click(r, st.x + st.w - 2, st.y)
    expect(r.app.panes.has("tasks")).toBe(true)
  })

  it("context chip → 300ms-debounced usage panel", () => {
    vi.useFakeTimers()
    try {
      const engine = statusful()
      const app = base(engine, { status: { path: "~/p", tickMs: 0, model: "m", plan: false, contextUsed: 1000, contextTotal: 100_000, todo: { done: 0, total: 0 }, tasks: { running: 0, labels: [] }, queue: 0, mcp: null } })
      const clipboard = makeClipboard()
      const called: string[] = []
      const router = new MouseRouter({
        app, engine, size: () => AREA, now: () => 0, clipboard, glyphs: GLYPHS, compact: false,
        hooks: { openUsagePanel: () => called.push("usage") },
      })
      const st = layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false }).status
      clickAt(router, st.x + st.w - 5, st.y) // context chip region (rightmost-ish)
      // A storm: clicking again within the window resets the debounce.
      clickAt(router, st.x + st.w - 5, st.y)
      vi.advanceTimersByTime(299)
      expect(called).toEqual([])
      vi.advanceTimersByTime(1)
      expect(called).toEqual(["usage"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("goal chip → goal detail hook; plan chip → plan view hook", () => {
    const engine = statusful()
    const app = base(engine, {
      status: { path: "~/p", tickMs: 0, model: "m", plan: true, goal: "ship it", todo: { done: 0, total: 0 }, tasks: { running: 0, labels: [] }, queue: 0, mcp: null },
    })
    const clipboard = makeClipboard()
    const called: string[] = []
    const router = new MouseRouter({
      app, engine, size: () => AREA, now: () => 0, clipboard, glyphs: GLYPHS, compact: false,
      hooks: { openGoalDetail: () => called.push("goal"), openPlanView: () => called.push("plan") },
    })
    const st = layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false }).status
    // chips stream: "plan" SEP "[Goal: " "ship it" "]" — widths 4,3,8,7,1 → 23.
    const x0 = st.x + st.w - 23
    clickAt(router, x0 + 2, st.y) // "plan" chip
    expect(called).toEqual(["plan"])
    clickAt(router, x0 + 14, st.y) // the goal label cell
    expect(called).toEqual(["plan", "goal"])
  })
})

describe("panes", () => {
  it("tasks group header click toggles collapse; [✗]/[↗] → honest toasts", () => {
    const engine = seeded()
    const app = base(engine, {
      paneData: {
        tasks: [{
          label: "Subagents",
          entries: [{ status: "running", label: "worker-1", action: "cancel" }],
        }],
      },
      panes: new Set(["tasks"]),
    })
    const clipboard = makeClipboard()
    const router = new MouseRouter({ app, engine, size: () => AREA, now: () => 0, clipboard, glyphs: GLYPHS, compact: false, hooks: {} })
    const lay = layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false })
    const t = lay.tasks!
    // header row (first row of the pane).
    router.handle({ x: t.x + 2, y: t.y, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    router.handle({ x: t.x + 2, y: t.y, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(app.paneData!.tasks![0]!.collapsed).toBe(true)
    // entry row — the [✗] button at the right edge.
    const entryY = t.y + 1
    router.handle({ x: t.x + t.w - 2, y: entryY, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    router.handle({ x: t.x + t.w - 2, y: entryY, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(app.toasts.map((x) => x.text)).toContain("cancel task (M46c)")
  })

  it("queue [cancel]/[Send now] toasts; todo row select sets paneData.todoSelect", () => {
    const engine = seeded()
    const app = base(engine, {
      paneData: {
        queue: [{ n: 1, kind: "prompt", text: "make tea", action: "cancel" }],
        todo: [{ id: "t1", text: "ship", status: "pending" }, { id: "t2", text: "docs", status: "completed" }],
      },
      panes: new Set(["queue", "todo"]),
    })
    const clipboard = makeClipboard()
    const router = new MouseRouter({ app, engine, size: () => AREA, now: () => 0, clipboard, glyphs: GLYPHS, compact: false, hooks: {} })
    const lay = layoutAgent(AREA, { ...app, dropdown: undefined }, { compact: false })
    // queue: the [cancel] chip is at the pane's right edge.
    const qy = lay.queue!.y
    router.handle({ x: lay.queue!.x + lay.queue!.w - 2, y: qy, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    router.handle({ x: lay.queue!.x + lay.queue!.w - 2, y: qy, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(app.toasts.map((x) => x.text)).toContain("queue cancel (M46c)")
    // todo: click the SECOND row → todoSelect = 1.
    router.handle({ x: lay.todo!.x + 2, y: lay.todo!.y + 1, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    router.handle({ x: lay.todo!.x + 2, y: lay.todo!.y + 1, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(app.paneData!.todoSelect).toBe(1)
  })
})

describe("dropdowns", () => {
  it("row click = cursor + accept (the host's overlaySelectRow), scrollbar col jumps", () => {
    const engine = seeded()
    const app = base(engine, {
      slash: {
        entries: Array.from({ length: 12 }, (_, i) => ({ command: `cmd${i}`, description: `d${i}` })),
        cursor: 0,
      },
    })
    const clipboard = makeClipboard()
    const accepted: number[] = []
    const router = new MouseRouter({
      app, engine, size: () => AREA, now: () => 0, clipboard, glyphs: GLYPHS, compact: false,
      hooks: { overlaySelectRow: (i) => accepted.push(i) },
    })
    const lay = layoutAgent(AREA, { ...app, dropdown: { kind: "slash", rows: 8 } }, { compact: false })
    const dd = lay.dropdown
    // row 3 click → cursor 3 + accept.
    router.handle({ x: dd.x + 2, y: dd.y + 3, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    router.handle({ x: dd.x + 2, y: dd.y + 3, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(app.slash!.cursor).toBe(3)
    expect(accepted).toEqual([3])
    // scrollbar column (right edge) at the bottom → cursor jumps proportionally.
    router.handle({ x: dd.x + dd.w - 1, y: dd.y + dd.h - 1, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    router.handle({ x: dd.x + dd.w - 1, y: dd.y + dd.h - 1, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(app.slash!.cursor).toBeGreaterThanOrEqual(0)
    expect(app.slash!.cursor).toBeLessThan(12)
  })
})

describe("links — Ctrl+click", () => {
  it("Ctrl+click arms; up on the same cell opens (seam absent → toast)", () => {
    const engine = createScrollbackEngine({ width: 80 })
    engine.append({ type: "assistant", text: "check https://example.com/path now\n", seq: 1, ts: 0 })
    const r = timedRig(engine)
    const row = r.sb.y
    const urlCol = r.sb.x + 4 + 6 // inside the url (after "check " prefix)
    r.at(0)
    r.router.handle({ x: urlCol, y: row, button: "left", kind: "down", drag: false, mods: { ctrl: true, shift: false, alt: false } })
    r.router.handle({ x: urlCol, y: row, button: "left", kind: "up", drag: false, mods: { ctrl: true, shift: false, alt: false } })
    expect(r.toasts().some((t) => t.includes("open link"))).toBe(true)
  })

  it("Ctrl+click on a DIFFERENT cell on up → no open", () => {
    const engine = createScrollbackEngine({ width: 80 })
    engine.append({ type: "assistant", text: "check https://example.com/path now\n", seq: 1, ts: 0 })
    const r = timedRig(engine)
    const row = r.sb.y
    const urlCol = r.sb.x + 4 + 6
    r.at(0)
    r.router.handle({ x: urlCol, y: row, button: "left", kind: "down", drag: false, mods: { ctrl: true, shift: false, alt: false } })
    r.router.handle({ x: urlCol + 8, y: row, button: "left", kind: "up", drag: false, mods: { ctrl: true, shift: false, alt: false } })
    expect(r.toasts().some((t) => t.includes("open link"))).toBe(false)
  })
})

describe("pure hit helpers", () => {
  it("fileRefAt / pasteChipAt / dropdownTotal", () => {
    expect(fileRefAt("see src/app/mouse.ts:42 now", 6)).toEqual({ file: "src/app/mouse.ts", line: 42 })
    expect(pasteChipAt("[Pasted: 5 lines] blob", 3)).toEqual({ lines: 5 })
    const app = base(seeded(), { slash: { entries: [{ command: "a" }], cursor: 0 } })
    expect(dropdownTotal(app)).toBe(1)
  })
})
