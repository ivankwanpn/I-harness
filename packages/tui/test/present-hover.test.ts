// M46b G1: the present() hover visuals — the scrollback row bg blend (a
// markdown row gets the BORDER instead), the timestamp hover swap
// (%H:%M:%S | %b %d), and the status cwd-chip underline. The hit areas
// register through the loop-owned engine; the test hands its own engine +
// last pointer into the state, presents TWICE (frame 1 settles the hover set
// from the registered areas; frame 2 draws with it) and asserts the front
// frame's cells.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { present } from "../src/app/present.ts"
import type { TuiAppState } from "../src/app/present.ts"
import { HoverEngine } from "../src/app/hover.ts"
import type { DisplayLine, ScrollbackEngine, TuiEvent } from "../src/contracts.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

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

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

interface FrontCell { text: string; style: { bg?: unknown; fg?: unknown; underline?: boolean } }
function front(r: Renderer): { cells: FrontCell[]; width: number } {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string; style: FrontCell["style"] }>; width: number } } }
  return inner.db.front as unknown as { cells: FrontCell[]; width: number }
}
function rowText(r: Renderer, y: number): string {
  const { cells, width } = front(r)
  let out = ""
  for (let x = 0; x < width; x++) out += cells[y * width + x].text
  return out.replace(/\0/g, "")
}
function bgOf(r: Renderer, x: number, y: number): unknown {
  return front(r).cells[y * front(r).width + x]?.style.bg
}
function lineOf(r: Renderer, text: string): number {
  for (let y = 0; y < 24; y++) {
    if (rowText(r, y).includes(text)) return y
  }
  return -1
}

const hoverBg = (): { r: number; g: number; b: number } => {
  const hex = palette.bgHover.startsWith("#") ? palette.bgHover.slice(1) : palette.bgHover
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }
}

describe("present — M46b G1 hover visuals", () => {
  it("hovered scrollback row: bg blend on the content cells (second frame settles)", () => {
    const engine = new StubEngine([
      { runs: [{ text: "row-a", style: "text" }], blockIndex: 0 },
      { runs: [{ text: "row-b", style: "text" }], blockIndex: 1 },
    ])
    const eng = new HoverEngine()
    const r = make(46, 24)
    // scrollback rect: y = rowsPad(1) + status(1) = 2; line 1 → y=3;
    // contentStart = x(colsPad 2)+rail 1+pad 2 = 5.
    const app = baseState(engine, {
      mouse: { enabled: true, last: { col: 6, row: 3 }, hovered: new Set(), engine: eng },
    })
    present(app, r, palette, GLYPHS, { cap }) // frame 1: registers + settles hovered={row-1}
    present(app, r, palette, GLYPHS, { cap }) // frame 2: draws the blend
    const yb = lineOf(r, "row-b")
    expect(yb).toBe(3)
    expect(bgOf(r, 7, yb)).toEqual(hoverBg()) // the text cell carries the blend
    // the non-hovered row keeps no bg.
    const ya = lineOf(r, "row-a")
    expect(bgOf(r, 7, ya)).toBeUndefined()
  })

  it("timestamp hover swaps the %H:%M:%S | %b %d detail on the same row", () => {
    const engine = new StubEngine([{
      runs: [{ text: "hello", style: "text" }],
      blockIndex: 0,
      timestamp: "  6:35 PM",
      timestampTs: 1_735_942_800_000,
    }])
    const eng = new HoverEngine()
    const r = make(46, 24)
    // The single row line 0 (y=2); the pointer over the row band.
    const app = baseState(engine, {
      scroll: { offset: 0, follow: false },
      mouse: { enabled: true, last: { col: 30, row: 2 }, hovered: new Set(), engine: eng },
    })
    present(app, r, palette, GLYPHS, { cap })
    present(app, r, palette, GLYPHS, { cap })
    const line = rowText(r, 2)
    // The extended 24h detail replaces the "6:35 PM" short form.
    expect(line).toMatch(/\d{2}:\d{2}:\d{2} \| [A-Z][a-z]{2} \d{2}/)
    expect(line).not.toContain("6:35 PM")
  })

  it("markdown row hover: border instead of the bg blend", () => {
    const engine = new StubEngine([
      { runs: [{ text: "plain", style: "text" }], blockIndex: 0 },
      { runs: [{ text: "**bold** md", style: "md-strong" }], blockIndex: 1 },
    ])
    const eng = new HoverEngine()
    const r = make(46, 24)
    const app = baseState(engine, {
      mouse: { enabled: true, last: { col: 6, row: 3 }, hovered: new Set(), engine: eng },
    })
    present(app, r, palette, GLYPHS, { cap })
    present(app, r, palette, GLYPHS, { cap })
    const yb = lineOf(r, "md")
    expect(yb).toBe(3)
    // The markdown row's pad-left cell wears the border glyph, NOT a bg fill
    // on the text cell (md rows are exempt from the blend).
    const padCell = front(r).cells[3 * front(r).width + 4]
    expect(padCell.text).toBe("│")
    const textBg = bgOf(r, 7, yb)
    expect(textBg).toBeUndefined()
  })

  it("cwd chip hover: underline style on the path", () => {
    const engine = new StubEngine([{ runs: [{ text: "x", style: "text" }], blockIndex: 0 }])
    const eng = new HoverEngine()
    const r = make(46, 24)
    // cwd span: x = 2 + 1(GIT_ICON) + 2... path starts at x = colsPad + 1 + 2 = 5
    // (no branch); ~/r width 3 → cols 5..8; status row y=1.
    const app = baseState(engine, {
      mouse: { enabled: true, last: { col: 6, row: 1 }, hovered: new Set(), engine: eng },
    })
    present(app, r, palette, GLYPHS, { cap })
    present(app, r, palette, GLYPHS, { cap })
    const y = lineOf(r, "~/r")
    expect(y).toBe(1)
    // any cell in the path span carries underline
    let underlined = false
    const { cells, width } = front(r)
    for (let x = 5; x < 9; x++) {
      if ((cells[y * width + x]?.style.underline ?? false) === true) underlined = true
    }
    expect(underlined).toBe(true)
  })
})
