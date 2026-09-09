// M46c G2: paste source retention — the paste INSERT stays immediate, the RAW
// source is stashed under a `[Pasted: N lines]` chip (prompt.pasteStash), the
// chip's double-click (through the mouse-router seam) inserts the FULL
// original (byte-equal), submit clears the stash.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/index.ts"
import type { BackendClient, TuiEvent } from "../src/index.ts"
import { layoutAgent } from "../src/views/agent.ts"
import { unsupportedSessionManagement } from "./backend-stub.ts"
import {
  isSizeablePaste,
  pasteChipRowAt,
  pasteLabel,
  pasteLineCount,
  promptCursorAtCell,
  promptCursorCell,
  renderPrompt,
} from "../src/views/prompt.ts"
import { makeDraw } from "../src/app/present.ts"

const cap: TerminalCapabilityContext = {
  ...createUnknownCapabilities(),
  colorLevel: "truecolor",
  dark: true,
  brand: "WindowsTerminal",
  multiplexer: "none",
}
const palette = resolvePalette(cap, "groknight")
const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

function stubBackend(): BackendClient {
  const events: TuiEvent[] = []
  return {
    ...unsupportedSessionManagement,
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    events: async function* () { for (const ev of events) yield ev },
    seqCursor: () => 0,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  }
}

describe("paste helpers", () => {
  it("isSizeablePaste: multi-line or ≥100 chars; single short text is plain", () => {
    expect(isSizeablePaste("a\nb")).toBe(true)
    expect(isSizeablePaste("x".repeat(100))).toBe(true)
    expect(isSizeablePaste("hello")).toBe(false)
    expect(isSizeablePaste("")).toBe(false)
  })

  it("pasteLineCount / pasteLabel: N lines with the singular/plural rule", () => {
    expect(pasteLineCount("a\nb\nc")).toBe(3)
    expect(pasteLineCount("a\nb\n\nc")).toBe(4)
    expect(pasteLineCount("one")).toBe(1)
    expect(pasteLabel("a\nb\nc")).toBe("3 lines")
    expect(pasteLabel("one")).toBe("1 line")
  })

  it("pasteChipRowAt: chip rows at the TOP content rows; outside → undefined", () => {
    const rect = { x: 0, y: 0, w: 60, h: 24 }
    const state = { text: "hello", cursor: 0, multiLine: false, focused: true, model: "m", plan: false, title: "t" }
    expect(pasteChipRowAt(rect, state, 1)).toBeUndefined() // no stash
    const stashed = { ...state, pasteStash: [{ label: "5 lines", text: "x" }, { label: "2 lines", text: "y" }] }
    expect(pasteChipRowAt(rect, stashed, 1)).toBe(0) // first chip row
    expect(pasteChipRowAt(rect, stashed, 2)).toBe(1) // second chip row
    expect(pasteChipRowAt(rect, stashed, 3)).toBeUndefined() // text area
    expect(pasteChipRowAt(rect, stashed, 0)).toBeUndefined() // top border
  })

  it("promptCursorAtCell: a chip row keeps the cursor; text rows shift by chips", () => {
    const p = { x: 0, y: 0, w: 60, h: 24 }
    const state = {
      text: "hello world", cursor: 3, multiLine: false, focused: true, model: "m", plan: false, title: "t",
      pasteStash: [{ label: "5 lines", text: "x" }],
    }
    expect(promptCursorAtCell(p, state, 2, 1)).toBe(3) // chip row = hint, no jump
    expect(promptCursorAtCell(p, state, 2, 2)).toBe(0) // first TEXT row (after the chip)
  })
})

describe("TuiApp — paste pipeline (M46c G2)", () => {
  const r = make(100, 24)

  const makeApp = (opts: Partial<ConstructorParameters<typeof TuiApp>[0]> = {}): TuiApp => new TuiApp({
    renderer: r,
    backend: stubBackend(),
    engine: createScrollbackEngine({ width: 100 }),
    capabilities: cap,
    palette,
    glyphs: GLYPHS,
    write: () => {},
    now: () => 13_334, // frozen clock — the multi-click window always holds
    ...opts,
  })

  const pasteEv = (text: string): InputEvent => ({ type: "paste", text })

  const mouseEv = (x: number, y: number, released: boolean): InputEvent => ({
    type: "mouse", x, y, button: "left", drag: false, released, motion: false,
    mods: { ctrl: false, shift: false, alt: false },
  })

  it("paste big text → immediate insert + `[Pasted: N lines]` stash; submit clears", () => {
    const app = makeApp()
    const big = "alpha\nbeta\ngamma\ndelta\nomega"
    app.feedInput(pasteEv(big))
    const p = app.state().prompt
    expect(p.text).toBe(big) // insert immediate (as today)
    expect(p.cursor).toBe(big.length)
    expect(p.pasteStash).toEqual([{ label: "5 lines", text: big }])
    // a short single-line paste is retained only by text (no extra chip).
    app.feedInput(pasteEv("tiny"))
    expect(app.state().prompt.text).toBe(big + "tiny")
    expect(app.state().prompt.pasteStash).toHaveLength(1)
    // submit → cleared.
    app.dispatch("submit")
    expect(app.state().prompt.text).toBe("")
    expect(app.state().prompt.pasteStash).toEqual([])
  })

  it("M60 C: a chip never eats the only text row — the layout grows and the caret sits on a content row", () => {
    const app = makeApp()
    app.feedInput(pasteEv("alpha\nbeta\ngamma\ndelta\nomega"))
    // One typed line + one chip: the DEFAULT 3-row composer would put the chip
    // on the only content row (text invisible, caret on the info border).
    const p = app.state().prompt
    p.text = "hello world"
    p.cursor = 6
    const rect = layoutAgent({ cols: 100, rows: 24 }, { ...app.state(), dropdown: undefined }, { compact: false }).prompt
    const r = make(100, 24)
    renderPrompt(rect, p, makeDraw(r.buffer, palette), palette, GLYPHS)
    r.commit()
    r.flush(() => {})
    const inner = r as unknown as { db: { front: { cells: Array<{ text: string }>; width: number } } }
    const line = (y: number): string => {
      let out = ""
      for (let x = 0; x < inner.db.front.width; x++) out += inner.db.front.cells[y * inner.db.front.width + x].text
      return out
    }
    expect(line(rect.y + 1)).toContain("[Pasted: 5 lines]") // the chip row
    expect(line(rect.y + 2)).toContain("hello world") // ...and the text is still drawn
    const caret = promptCursorCell(rect, p)
    expect(caret.y).toBeGreaterThan(rect.y) // not the top border
    expect(caret.y).toBeLessThan(rect.y + rect.h - 1) // not the info border
  })

  it("double-click on the chip → the atom is expanded in place (source stays, chip released)", () => {
    const app = makeApp()
    const big = "alpha\nbeta\ngamma\ndelta\nomega"
    app.feedInput(pasteEv(big))
    // Move the cursor to the START so the insert lands at 0.
    app.state().prompt.cursor = 0
    const area = { cols: 100, rows: 24 }
    const rect = layoutAgent(area, { ...app.state(), dropdown: undefined }, { compact: false }).prompt
    const rowY = rect.y + 1 // chip row (top of the content area)
    const colX = rect.x + 4
    // click twice (frozen clock ⇒ second click is within the multi-click window)
    app.feedInput(mouseEv(colX + 1, rowY + 1, false))
    app.feedInput(mouseEv(colX + 1, rowY + 1, true))
    app.feedInput(mouseEv(colX + 1, rowY + 1, false))
    app.feedInput(mouseEv(colX + 1, rowY + 1, true))
    const p = app.state().prompt
    // Task 7: the chip is an atomic element — the double-click EXPANDS it to
    // editable text (the source byte-preserved in place, NOT re-inserted).
    expect(p.text).toBe(big)
    expect(p.text.split(big)).toHaveLength(2)
    expect(p.cursor).toBe(big.length)
    expect(p.pasteStash).toEqual([]) // the atom released its chip row
  })

  it("M49: the pasted block is ONE atomic cursor element — arrows hop over, backspace removes it", () => {
    const app = makeApp()
    const big = "alpha\nbeta\ngamma\ndelta\nomega"
    app.feedInput(pasteEv(big))
    // From the atom-end, Left hops over the WHOLE block (never into it).
    const left: InputEvent = newKeyEvent("Left")
    app.feedInput(left)
    expect(app.state().prompt.cursor).toBe(0)
    // Home/End stay useable; a backspace at the end removes the whole atom.
    app.state().prompt.cursor = big.length // direct fixture write (mouse path)
    app.feedInput(newKeyEvent("End"))
    app.feedInput(newKeyEvent("Backspace"))
    const p = app.state().prompt
    expect(p.text).toBe("")
    expect(p.pasteStash).toEqual([]) // the block is gone with its chip
  })
})

/** A minimal key event (the loop's editor path translates it via the keymap). */
function newKeyEvent(code: string): InputEvent {
  return {
    type: "key", code, key: "", ctrl: false, alt: false, shift: false,
  } as unknown as InputEvent
}
