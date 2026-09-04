// G1 (M43): rewind view — §3.9 phase goldens on the drawn cell grid (the
// permission.test.ts row-capture approach), the spec key table, the confirm
// title rows (clean + conflicts + `+N more` caps) and the engine's rewind
// marker row + rewindAnchor accessor.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { makeDraw } from "../src/app/present.ts"
import {
  filesDisabled,
  rewindConfirmTitle,
  rewindConfirmRows,
  rewindKeys,
  renderRewind,
} from "../src/views/rewind.ts"
import type { RewindState } from "../src/views/rewind.ts"
import type { KeyLike } from "../src/views/permission.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import type { TuiEvent } from "../src/contracts.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

/** Visible text of one drawn row (reads the committed front frame). */
const rowText = (r: Renderer, y: number): string => {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string }>; width: number } } }
  const { cells, width } = inner.db.front
  let out = ""
  for (let x = 0; x < width; x++) out += cells[y * width + x].text
  return out
}

const cellAt = (r: Renderer, x: number, y: number): { text: string; style: Record<string, unknown> } => {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string; style: Record<string, unknown> }>; width: number } } }
  return inner.db.front.cells[y * inner.db.front.width + x]
}

const drawRewind = (r: Renderer, state: RewindState, w = 60): void => {
  renderRewind({ x: 2, y: 2, w, h: 16 }, state, makeDraw(r.buffer, palette), palette, GLYPHS)
  r.commit()
  r.flush(() => {})
}

const kbd = (partial: Partial<KeyLike>): KeyLike => ({
  code: "char",
  key: "",
  ctrl: false,
  alt: false,
  shift: false,
  ...partial,
})
const letter = (key: string): KeyLike => kbd({ code: "char", key })

const baseState = (partial: Partial<RewindState> = {}): RewindState => ({
  phase: "loading",
  points: [],
  cursor: 0,
  cleanPaths: [],
  conflicts: [],
  ...partial,
})

describe("renderRewind — §3.9 phase goldens", () => {
  it("loading: `Loading rewind points...`", () => {
    const r = make(80, 24)
    drawRewind(r, baseState({ phase: "loading" }))
    expect(rowText(r, 2)).toContain("Loading rewind points...")
  })

  it("picker: title + `· {preview} · {N} files` rows; (no preview) when 0 files", () => {
    const r = make(80, 24)
    drawRewind(r, baseState({
      phase: "picker",
      points: [
        { turnIndex: 0, preview: "Write hello", files: 2 },
        { turnIndex: 1, preview: "Fix tests", files: 0 },
      ],
      cursor: 1,
    }))
    expect(rowText(r, 2)).toContain("Rewind to which turn?")
    expect(rowText(r, 3)).toContain("· Write hello · 2 files")
    expect(rowText(r, 4)).toContain("· Fix tests · (no preview)")
    // cursor row (row 1 of the list) paints bg_visual (#363636) behind its cells
    expect(cellAt(r, 4, 4).style.bg).toEqual({ r: 0x36, g: 0x36, b: 0x36 })
  })

  it("cancel-offer: accent title + body + y/n radio rows", () => {
    const r = make(80, 24)
    drawRewind(r, baseState({ phase: "cancel-offer", cursor: 0 }))
    expect(rowText(r, 2)).toContain("A turn is currently running.")
    expect(rowText(r, 3)).toContain("Would you like to cancel it before rewinding?")
    expect(rowText(r, 4)).toContain("y (●) Cancel turn and rewind")
    expect(rowText(r, 5)).toContain("n (○) Let it finish")
  })

  it("mode-select: a/b/f rows, f disabled (○) when the target recorded no files", () => {
    const r = make(80, 24)
    drawRewind(r, baseState({
      phase: "mode-select",
      points: [{ turnIndex: 0, preview: "Write hello", files: 1 }],
      selectedTurn: 0,
      cursor: 1,
    }))
    expect(rowText(r, 2)).toContain("What do you want to rewind?")
    expect(rowText(r, 3)).toContain("a (○) Both conversation and file changes")
    expect(rowText(r, 4)).toContain("b (●) Conversation only")

    const r2 = make(80, 24)
    drawRewind(r2, baseState({
      phase: "mode-select",
      points: [{ turnIndex: 0, preview: "Chat only", files: 0 }],
      selectedTurn: 0,
      cursor: 2,
    }))
    expect(rowText(r2, 5)).toContain("f (○) File changes only") // disabled marker stays ○
  })

  it("planning: `Previewing file changes...`", () => {
    const r = make(80, 24)
    drawRewind(r, baseState({ phase: "planning" }))
    expect(rowText(r, 2)).toContain("Previewing file changes...")
  })

  it("confirm: mode title with preview + ({N} files), clean gray, conflicts warning, y/Bksp rows", () => {
    const r = make(120, 24)
    drawRewind(r, baseState({
      phase: "confirm",
      points: [{ turnIndex: 0, preview: "Write hello", files: 5 }],
      selectedTurn: 0,
      mode: "all",
      cleanPaths: ["src/a.txt", "src/b.txt"],
      conflicts: [
        { path: "z.txt", kind: "modified" },
        { path: "gone.txt", kind: "deleted" },
        { path: "new.txt", kind: "created" },
      ],
      cursor: 0,
    }), 100)
    expect(rowText(r, 2)).toContain('Rewind file changes and conversation to "Write hello"? (5 files)')
    expect(rowText(r, 3)).toContain("src/a.txt")
    expect(rowText(r, 4)).toContain("src/b.txt")
    expect(rowText(r, 5)).toContain("! z.txt (modified)")
    expect(rowText(r, 6)).toContain("! gone.txt (deleted)")
    expect(rowText(r, 7)).toContain("! new.txt (added)") // created → added (spec tokens)
    expect(rowText(r, 8)).toContain("y (●) Confirm rewind")
    expect(rowText(r, 9)).toContain("Bksp (○) Back")
  })

  it("confirm caps: each category lists 5 + `+N more`", () => {
    const clean = Array.from({ length: 7 }, (_, i) => `c${i}.txt`)
    const conflicts = Array.from({ length: 6 }, (_, i) => ({ path: `x${i}.txt`, kind: "modified" as const }))
    const rows = rewindConfirmRows(baseState({
      phase: "confirm",
      points: [{ turnIndex: 0, preview: "w", files: 13 }],
      selectedTurn: 0,
      mode: "all",
      cleanPaths: clean,
      conflicts,
    }))
    expect(rows).toEqual([
      "c0.txt", "c1.txt", "c2.txt", "c3.txt", "c4.txt", "+2 more",
      "! x0.txt (modified)", "! x1.txt (modified)", "! x2.txt (modified)",
      "! x3.txt (modified)", "! x4.txt (modified)", "+1 more",
    ])
  })

  it("executing: `Rewinding...`", () => {
    const r = make(80, 24)
    drawRewind(r, baseState({ phase: "executing" }))
    expect(rowText(r, 2)).toContain("Rewinding...")
  })

  it("error: `Rewind failed` + msg + Esc Dismiss", () => {
    const r = make(80, 24)
    drawRewind(r, baseState({ phase: "error", error: "blob missing: abc", cursor: 0 }))
    expect(rowText(r, 2)).toContain("Rewind failed")
    expect(rowText(r, 3)).toContain("blob missing: abc")
    expect(rowText(r, 4)).toContain("Esc (●) Dismiss") // cursor row (0) filled
  })

  it("rewindConfirmTitle: mode verbs", () => {
    const pt = [{ turnIndex: 0, preview: "Hello", files: 2 }]
    expect(rewindConfirmTitle(baseState({ mode: "all", points: pt, selectedTurn: 0, cleanPaths: ["a"], conflicts: [] }))).toBe('Rewind file changes and conversation to "Hello"? (1 files)')
    expect(rewindConfirmTitle(baseState({ mode: "files", points: pt, selectedTurn: 0, cleanPaths: ["a"], conflicts: [] }))).toBe('Rewind file changes to "Hello"? (1 files)')
    expect(rewindConfirmTitle(baseState({ mode: "conversation", points: pt, selectedTurn: 0, cleanPaths: [], conflicts: [] }))).toBe('Rewind conversation to "Hello"?')
    // zero files → no suffix regardless of mode
    expect(rewindConfirmTitle(baseState({ mode: "all", points: pt, selectedTurn: 0, cleanPaths: [], conflicts: [] }))).toBe('Rewind file changes and conversation to "Hello"?')
  })

  it("filesDisabled: target turn with 0 files", () => {
    expect(filesDisabled(baseState({ selectedTurn: 0, points: [{ turnIndex: 0, preview: "x", files: 0 }] }))).toBe(true)
    expect(filesDisabled(baseState({ selectedTurn: 0, points: [{ turnIndex: 0, preview: "x", files: 2 }] }))).toBe(false)
    expect(filesDisabled(baseState({ selectedTurn: undefined }))).toBe(true)
  })
})

describe("rewindKeys — §3.9 key table", () => {
  it("nav j/k/up/down + accept + dismiss + back", () => {
    expect(rewindKeys(letter("j"), "picker")).toEqual({ action: "nav-next" })
    expect(rewindKeys(letter("k"), "picker")).toEqual({ action: "nav-prev" })
    expect(rewindKeys(kbd({ code: "Up", key: "ArrowUp" }), "picker")).toEqual({ action: "nav-prev" })
    expect(rewindKeys(kbd({ code: "Down", key: "ArrowDown" }), "picker")).toEqual({ action: "nav-next" })
    expect(rewindKeys(kbd({ code: "Enter", key: "Enter" }), "picker")).toEqual({ action: "accept" })
    expect(rewindKeys(kbd({ code: "Esc", key: "Esc" }), "picker")).toEqual({ action: "dismiss" })
    expect(rewindKeys(kbd({ code: "Backspace", key: "Backspace" }), "confirm")).toEqual({ action: "back" })
  })

  it("y is phase-interpreted: cancel-offer → choose-cancel-y; confirm → confirm-y", () => {
    expect(rewindKeys(letter("y"), "cancel-offer")).toEqual({ action: "choose-cancel-y" })
    expect(rewindKeys(letter("y"), "confirm")).toEqual({ action: "confirm-y" })
    expect(rewindKeys(letter("y"), "picker")).toEqual({ action: "confirm-y" }) // generic yes
    expect(rewindKeys(letter("n"), "cancel-offer")).toEqual({ action: "choose-cancel-n" })
  })

  it("mode keys a/b/f + c dismiss + unbound/modified → undefined", () => {
    expect(rewindKeys(letter("a"), "mode-select")).toEqual({ action: "mode-a" })
    expect(rewindKeys(letter("b"), "mode-select")).toEqual({ action: "mode-b" })
    expect(rewindKeys(letter("f"), "mode-select")).toEqual({ action: "mode-f" })
    expect(rewindKeys(letter("c"), "picker")).toEqual({ action: "dismiss" })
    expect(rewindKeys(letter("q"), "picker")).toBeUndefined()
    expect(rewindKeys(letter("1"), "picker")).toBeUndefined()
    expect(rewindKeys(kbd({ code: "char", key: "y", ctrl: true }), "confirm")).toBeUndefined()
    expect(rewindKeys(letter("Y"), "confirm")).toBeUndefined() // shifted
  })
})

describe("engine — rewind marker row + anchor accessor", () => {
  it("appends `Rewound to turn {N}` system-style row and exposes the anchor line", () => {
    const engine = createScrollbackEngine({ width: 80 })
    expect(engine.rewindAnchor!()).toBeUndefined()
    engine.append({ type: "user", text: "hi", seq: 0, ts: 0 })
    engine.append({ type: "rewind", targetTurn: 1, anchorSeq: 12, mode: "all", seq: 1, ts: 0 })
    const lines = engine.viewport(0, 10)
    expect(lines.find((l) => l.runs.some((r) => r.text === "Rewound to turn 1"))).toBeDefined()
    expect(engine.rewindAnchor!()).toBe(1)
    // a second rewind moves the anchor to the newer marker
    engine.append({ type: "rewind", targetTurn: 3, anchorSeq: 12, mode: "conversation", seq: 2, ts: 0 })
    expect(engine.rewindAnchor!()).toBe(2)
  })

  it("re-delivered seq is ignored (no marker, anchor stays)", () => {
    const engine = createScrollbackEngine({ width: 80 })
    engine.append({ type: "rewind", targetTurn: 1, anchorSeq: 12, mode: "all", seq: 5, ts: 0 })
    engine.append({ type: "rewind", targetTurn: 1, anchorSeq: 12, mode: "all", seq: 5, ts: 0 })
    expect(engine.rewindAnchor!()).toBe(0)
    expect(engine.lineCount()).toBe(1)
  })

  it("folding above the anchor recomputes the index (on-demand, never stale)", () => {
    const engine = createScrollbackEngine({ width: 80 })
    // a multi-line user block (12 logical lines) — auto state = collapsed
    // (cap-3) so the marker starts at line 3; expanding it moves the marker.
    engine.append({
      type: "user",
      text: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"),
      seq: 0, ts: 0,
    })
    engine.append({ type: "rewind", targetTurn: 0, anchorSeq: 12, mode: "all", seq: 1, ts: 0 })
    expect(engine.rewindAnchor!()).toBe(3) // collapsed cap-3
    engine.toggleFoldAt(0) // expand → 12 rows above the marker
    expect(engine.rewindAnchor!()).toBe(12)
  })
})

describe("engine — rewind event plumbing types", () => {
  it("contract event round-trips through append", () => {
    const engine = createScrollbackEngine({ width: 80 })
    const ev: TuiEvent = { type: "rewind", targetTurn: 2, anchorSeq: 12, mode: "files", seq: 4, ts: 1 }
    engine.append(ev)
    const row = engine.viewport(0, 10)[0]
    expect(row?.runs[0]).toMatchObject({ text: "Rewound to turn 2" })
  })
})
