// M37a G2: present() — the single draw point. Assert on the drawn CELL grid
// (the committed front frame — `cellRow` reads it via the renderer internals;
// the public `buffer` handle holds the PREVIOUS frame after commit, M36
// Footgun A) plus the flush-byte loop contract (identical redraw → "").

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { present } from "../src/app/present.ts"
import type { TuiAppState } from "../src/app/present.ts"
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

/** Visible text of one drawn row (reads the committed front frame). */
const rowText = (r: Renderer, y: number): string => {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string; style: unknown }>; width: number } } }
  const { cells, width } = inner.db.front
  let out = ""
  for (let x = 0; x < width; x++) out += cells[y * width + x].text
  return out
}

/** Draw+commit+flush once; returns the output bytes. */
const drawAndFlush = (state: TuiAppState, r: Renderer, writes: string[]): string => {
  present(state, r, palette, GLYPHS, {})
  return r.flush((s) => writes.push(s))
}

describe("present — zero-byte idle (M36 contract)", () => {
  it("identical redraw → commit sameFrame → flush returns '' and writes nothing", () => {
    const r = make(80, 24)
    const state = baseState(new StubEngine())
    const writes: string[] = []
    const first = drawAndFlush(state, r, writes)
    expect(first.length).toBeGreaterThan(0)
    expect(writes.length).toBe(1) // one frame written
    const second = drawAndFlush(state, r, writes)
    expect(second).toBe("")
    expect(writes.length).toBe(1) // zero-byte idle: no extra write
  })
})

describe("present — prompt chrome (spec §3.2)", () => {
  it("draws ╭──╮ top border with the title right-aligned, │ sides, ╰──╯ info row, ❯ + placeholder", () => {
    const r = make(80, 24)
    const state = baseState(new StubEngine())
    state.prompt.plan = true // plan flag shows ` · plan` in the info row
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})

    // Layout: pads 2/1; prompt box 76 wide at x=2, lines=1 → height 6, top at y=15.
    const top = rowText(r, 15)
    expect(top.slice(2, 4)).toBe("╭─")
    expect(top.slice(76, 78)).toBe("─╮")
    expect(top.slice(73, 76)).toBe("sup") // title right-aligned inside the border
    const rail = rowText(r, 16)
    expect(rail[1]).toBe("┃") // accent rail left of the box
    expect(rail[2]).toBe("│") // side border
    expect(rail).toContain("❯ Build anything")
    expect(rail[77]).toBe("│")
    const bottom = rowText(r, 20)
    expect(bottom.slice(2, 3)).toBe("╰") // info line is embedded over the border dashes
    expect(bottom.slice(76, 78)).toBe("─╯")
    expect(bottom).toContain("mock-model")
    expect(bottom).toContain(" · plan")
    const shortcuts = rowText(r, 22)
    expect(shortcuts).toContain("j/k: scroll")
  })

  it("multiline flag puts `multiline` on the right of the info row", () => {
    const r = make(80, 24)
    const state = baseState(new StubEngine())
    state.prompt.multiLine = true
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})
    expect(rowText(r, 20)).toContain("multiline")
  })

  it("wraps CJK prompt text (wcwidth) with 2-space continuation indent", () => {
    const r = make(24, 20) // content width = 24-4-4 = 16 → 8 CJK per line
    const text = "你".repeat(20)
    const state = baseState(new StubEngine())
    state.prompt.text = text
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})
    // prompt box: x=2..21 (w=20); content rows from y = shortcuts(19)-1-… :
    // find the row with the first 8 你s after the ❯ prefix.
    let found = 0
    for (let y = 0; y < 20 && found < 3; y++) {
      const row = rowText(r, y)
      if (!row.includes("你")) continue
      if (found === 0) {
        expect(row).toMatch(/❯ 你{8}/)
      } else if (found === 1) {
        expect(row).toMatch(/^ ┃│ {2}你{8}/) // rail ┃ + side border │ + 2-col continuation indent
      } else {
        expect(row).toMatch(/^ ┃│ {2}你{4}/) // 8+8+4 chars
      }
      found++
    }
    expect(found).toBe(3)
  })
})

describe("present — status chips (spec §3.3)", () => {
  it("formats context gradient, todo, queue, plan, goal with │ separators", () => {
    const r = make(80, 24)
    const state = baseState(new StubEngine())
    state.status.contextUsed = 8500
    state.status.contextTotal = 1_000_000
    state.status.todo = { done: 2, total: 5 }
    state.status.queue = 3
    state.status.plan = true
    state.status.goal = "ship it"
    state.status.branch = "m37"
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})
    const row = rowText(r, 1)
    expect(row).toContain("⎇ m37  ~/r")
    expect(row).toContain("plan")
    expect(row).toContain("[Goal: ship it]")
    expect(row).toContain("8.5K / 1.0M")
    expect(row).toContain("+3")
    expect(row).toContain("2/5 ✓")
    expect(row).toContain(" │ ")
  })

  it("no todo chip when there are no todo items", () => {
    const r = make(80, 24)
    const state = baseState(new StubEngine())
    state.status.contextUsed = 0
    state.status.contextTotal = 1000
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})
    const row = rowText(r, 1)
    expect(row).toContain("0 / 1.0K")
    expect(row).not.toContain("✓")
  })
})

describe("present — scrollback chrome (spec §3.1)", () => {
  it("draws the accent rail, ◆ bullets, ❙ for collapsed, runs and right-aligned timestamps", () => {
    const engine = new StubEngine([
      // glyph is engine-resolved into DisplayLine (M37a single-glyph rule);
      // header text carries the one-space lead so it reads "◆ Read …".
      { runs: [{ text: " Run bash", style: "accent-system" }], blockIndex: 0, timestamp: "  6:35 PM", glyph: "◆" },
      { runs: [{ text: " Read file", style: "accent-plan" }], blockIndex: 1, collapsed: true, glyph: "❙" },
      { runs: [{ text: "Plain text", style: "text" }], blockIndex: 2 },
    ])
    const r = make(80, 24)
    const state = baseState(engine)
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})
    const l0 = rowText(r, 2)
    expect(l0[2]).toBe("┃")
    expect(l0).toContain("◆")
    expect(l0).toContain("Run bash")
    const l1 = rowText(r, 3)
    expect(l1).toContain("❙")
    expect(l1).toContain("Read file")
    const l2 = rowText(r, 4)
    expect(l2).toContain("Plain text")
    // timestamp right-aligned inside the content column (ends at x=75)
    expect(l0.slice(67, 76)).toBe("  6:35 PM")
  })
})

describe("present — turn status row (spec §3.4)", () => {
  it("draws spinner + label + phase/turn timers + ⇣12k + [stop]", () => {
    const r = make(80, 24)
    const state = baseState(new StubEngine())
    state.turn = {
      phase: "thinking",
      attempts: 1,
      phaseMs: 3000,
      turnMs: 62000,
      tokens: 12050,
      nowMs: 133,
      canStop: true,
    }
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})
    const row = rowText(r, 13) // turn row sits above the prompt gap
    expect(row.slice(2, 3)).toBe("⠋")
    expect(row).toContain("Thinking…")
    expect(row).toContain("0:03")
    expect(row).toContain("1m02s")
    expect(row).toContain("⇣12k")
    expect(row).toContain("[stop]")
  })

  it("idle hides the turn row (§7) — the prompt gap row stays blank above the box", () => {
    const r = make(80, 24)
    const state = baseState(new StubEngine())
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})
    const row = rowText(r, 13)
    expect(row).not.toContain("[stop]")
  })
})

describe("present — toasts (M40 G2)", () => {
  /** Style-bearing cell reader (the committed front frame). */
  const cellAt = (r: Renderer, x: number, y: number): { text: string; style: Record<string, unknown> } => {
    const inner = r as unknown as { db: { front: { cells: Array<{ text: string; style: Record<string, unknown> }>; width: number } } }
    const { cells, width } = inner.db.front
    return cells[y * width + x]
  }

  it("renders ONLY the newest toast — bottom-row card, bold accent-user on bgBase, pad 1", () => {
    const r = make(80, 24)
    const state = baseState(new StubEngine())
    state.toasts = [
      { text: "older toast", until: 1e12 },
      { text: "Copied!", until: 1e12 + 1 },
    ]
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})
    const row = rowText(r, 23) // the blank bottom pad row (shortcuts sit on 22)
    expect(row).toContain("Copied!")
    expect(row).not.toContain("older")
    // right-anchored fit-to-width card: x=71..79 (9 cols), text 72..78, pad 71+79
    expect(row.slice(78, 79)).toBe("!")
    // pad cell: bgBase fills behind; text cell: bold accent-user on bgBase
    const padCell = cellAt(r, 71, 23)
    expect(padCell.text).toBe(" ")
    expect(padCell.style["bg"]).toEqual({ r: 0x14, g: 0x14, b: 0x14 })
    const textCell = cellAt(r, 72, 23)
    expect(textCell.text).toBe("C")
    expect(textCell.style["bold"]).toBe(true)
    expect(textCell.style["fg"]).toEqual({ r: 0xc8, g: 0xc8, b: 0xc8 })
    expect(textCell.style["bg"]).toEqual({ r: 0x14, g: 0x14, b: 0x14 })
  })

  it("no toasts → no card (zero cells at the bottom row)", () => {
    const r = make(80, 24)
    const state = baseState(new StubEngine())
    present(state, r, palette, GLYPHS, {})
    r.flush(() => {})
    expect(rowText(r, 23).trim()).toBe("")
  })
})
