// G1 (M37b): question modal — single vs multi markers, the sticky `z`
// freeform row, footer left/right, and the spec §4 key table (1-9/a-f).

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { makeDraw } from "../src/app/present.ts"
import { questionKeys, renderQuestion } from "../src/views/question.ts"
import type { QuestionQuestion, QuestionState } from "../src/views/question.ts"
import type { KeyLike } from "../src/views/permission.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

const rowText = (r: Renderer, y: number): string => {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string; style: unknown }>; width: number } } }
  const { cells, width } = inner.db.front
  let out = ""
  for (let x = 0; x < width; x++) out += cells[y * width + x].text
  return out
}

const drawQuestion = (r: Renderer, q: QuestionQuestion, state: QuestionState): void => {
  renderQuestion({ x: 2, y: 2, w: 60, h: 14 }, q, state, makeDraw(r.buffer, palette), palette, GLYPHS)
  r.commit() // swap drawn frame → front (what flush() and rowText read)
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

const singleQ = (): QuestionQuestion => ({
  id: "q1",
  label: "Pick a fruit",
  description: "choose one that you like",
  options: [{ key: "1", label: "Apple" }, { key: "2", label: "Banana" }],
  multi: false,
  freeform: true,
})

const state = (partial: Partial<QuestionState> = {}): QuestionState => ({
  page: 1,
  pages: 2,
  cursor: 0,
  selected: [],
  freeformFocused: false,
  freeformText: "",
  ...partial,
})

describe("renderQuestion — spec §3.8", () => {
  it("single mode: (●) cursor / (○) options, label bold, footer left + right pill", () => {
    const r = make(80, 24)
    drawQuestion(r, singleQ(), state())
    expect(rowText(r, 2)).toContain("Pick a fruit")
    expect(rowText(r, 3)).toContain("choose one that you like")
    expect(rowText(r, 5)).toContain("1 (●) Apple")
    expect(rowText(r, 6)).toContain("2 (○) Banana")
    expect(rowText(r, 14)).toContain("z (○) ❯ Type your answer here")
    const footer = rowText(r, 15)
    expect(footer).toContain("[1/2] ↑/↓ navigate · ←/→ question · y copy")
    expect(footer.slice(46)).toContain("Enter: submit") // right pill
  })

  it("multi mode: [x]/[ ] markers + `Enter: select` pill", () => {
    const r = make(80, 24)
    drawQuestion(r, { ...singleQ(), multi: true }, state({ selected: ["1"], cursor: 1 }))
    expect(rowText(r, 5)).toContain("1 [x] Apple")
    expect(rowText(r, 6)).toContain("2 [ ] Banana")
    expect(rowText(r, 15)).toContain("Enter: select")
  })

  it("freeform row: focused (●) marker + typed text instead of the placeholder", () => {
    const r = make(80, 24)
    drawQuestion(r, singleQ(), state({ freeformFocused: true, freeformText: "kiwi" }))
    expect(rowText(r, 14)).toContain("z (●) ❯ kiwi")
    expect(rowText(r, 14)).not.toContain("Type your answer here")
  })

  it("description caps at 5 lines + `... Ctrl-F to expand`", () => {
    const r = make(80, 24)
    const desc = Array.from({ length: 9 }, (_, i) => `paragraph line ${i}`).join("\n")
    drawQuestion(r, { ...singleQ(), description: desc }, state())
    expect(rowText(r, 3)).toContain("paragraph line 0")
    expect(rowText(r, 7)).toContain("... Ctrl-F to expand") // cap row is replaced by the hint
    expect(rowText(r, 7)).not.toContain("paragraph line")
    expect(rowText(r, 14)).toContain("z (○) ❯ Type your answer here") // freeform row intact
  })
})

describe("questionKeys — spec §4", () => {
  it("1-9 choose 0-8; a-f choose 9-14", () => {
    expect(questionKeys(letter("1"))).toEqual({ action: "choose", index: 0 })
    expect(questionKeys(letter("9"))).toEqual({ action: "choose", index: 8 })
    expect(questionKeys(letter("a"))).toEqual({ action: "choose", index: 9 })
    expect(questionKeys(letter("f"))).toEqual({ action: "choose", index: 14 })
  })

  it("z freeform, y copy, j/k nav", () => {
    expect(questionKeys(letter("z"))).toEqual({ action: "freeform" })
    expect(questionKeys(letter("y"))).toEqual({ action: "copy" })
    expect(questionKeys(letter("j"))).toEqual({ action: "nav-down" })
    expect(questionKeys(letter("k"))).toEqual({ action: "nav-up" })
  })

  it("Ctrl-Y dismiss; Esc back; Shift-X / Ctrl-C submit; Tab focus; ]/[ next/prev", () => {
    expect(questionKeys(kbd({ code: "char", key: "y", ctrl: true }))).toEqual({ action: "dismiss" })
    expect(questionKeys(kbd({ code: "Esc", key: "Esc" }))).toEqual({ action: "back" })
    expect(questionKeys(kbd({ code: "char", key: "X", shift: true }))).toEqual({ action: "submit" })
    expect(questionKeys(kbd({ code: "char", key: "c", ctrl: true }))).toEqual({ action: "submit" })
    expect(questionKeys(kbd({ code: "Tab", key: "\t" }))).toEqual({ action: "focus-change" })
    expect(questionKeys(letter("]"))).toEqual({ action: "next" })
    expect(questionKeys(letter("["))).toEqual({ action: "prev" })
  })

  it("unbound → undefined", () => {
    expect(questionKeys(letter("q"))).toBeUndefined()
    expect(questionKeys(kbd({ code: "Enter", key: "Enter" }))).toBeUndefined()
  })
})
