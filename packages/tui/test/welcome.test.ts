// M37b G2: welcome hero (spec §2a) — two-column ≥90 cols vs stacked below;
// menu rows `{key} {label}`, version right on the border, error line above.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { makeDraw } from "../src/app/present.ts"
import { renderWelcome, WELCOME_WIDE_MIN } from "../src/views/welcome.ts"
import type { WelcomeState } from "../src/views/welcome.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

const rowText = (r: Renderer, y: number): string => {
  const cells = r.buffer.cells
  const w = r.buffer.width
  let out = ""
  for (let x = 0; x < w; x++) out += cells[y * w + x].text
  return out
}

const cellAt = (r: Renderer, x: number, y: number) => r.buffer.cells[y * r.buffer.width + x]

const rgb = (hex: string): { r: number; g: number; b: number } => {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}

/** Style-fg matcher: { fg: rgb }. */
const fg = (hex: string): { fg: { r: number; g: number; b: number } } => ({ fg: rgb(hex) })

const draw = (r: Renderer, fn: (view: ReturnType<typeof makeDraw>) => void): void => {
  fn(makeDraw(r.buffer, palette))
}

const state: WelcomeState = {
  version: "0.1.0",
  menus: [
    { key: "ctrl+s", label: "Resume session" },
    { key: "ctrl+n", label: "New session" },
    { key: "ctrl+q", label: "Quit" },
  ],
  cursor: 0,
}

describe("welcome hero (spec §2a)", () => {
  it(`wide layout (>= ${WELCOME_WIDE_MIN} cols): logo left + version right, menu column right`, () => {
    const r = make(100, 30)
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 100, h: 30 }, state, view, palette, GLYPHS))
    const top = rowText(r, 0)
    expect(top.slice(2, 4)).toBe("╭─") // boxX = 2 (centered 96-col hero)
    expect(top).toContain("v0.1.0")
    expect(rowText(r, 1)).toContain("I-harness")
    expect(rowText(r, 1)).toContain("ctrl+s Resume session")
    expect(rowText(r, 2)).toContain("Thanks for trying I-harness, give feedback")
    expect(rowText(r, 2)).toContain("ctrl+n New session")
    expect(rowText(r, 3)).toContain("ctrl+q Quit")
    // cursor row fills bg_visual in the menu column (past the text runs).
    expect(cellAt(r, 80, 1).style).toMatchObject({ bg: rgb(palette.bgVisual) })
    expect(cellAt(r, 80, 3).style).not.toMatchObject({ bg: rgb(palette.bgVisual) })
  })

  it("stacked below 90 cols: logo/subtitle then the menu rows, one column", () => {
    const r = make(60, 30)
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 60, h: 30 }, state, view, palette, GLYPHS))
    expect(rowText(r, 0)).toContain("╭")
    expect(rowText(r, 1)).toContain("I-harness")
    expect(rowText(r, 2)).toContain("Thanks for trying I-harness, give feedback with")
    expect(rowText(r, 3)).toContain("ctrl+s Resume session")
    expect(rowText(r, 4)).toContain("ctrl+n New session")
    expect(rowText(r, 5)).toContain("ctrl+q Quit")
    expect(rowText(r, 0)).toContain("v0.1.0")
  })

  it("error line above the box, red", () => {
    const r = make(100, 30)
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 100, h: 30 }, { ...state, error: "trust issue" }, view, palette, GLYPHS))
    expect(rowText(r, 0)).toContain("trust issue")
    expect(cellAt(r, 0, 0).style).toMatchObject(fg(palette.accentError))
    expect(rowText(r, 1).slice(2, 4)).toBe("╭─") // hero shifts one row down
  })

  it("menu key hints bold accent_user", () => {
    const r = make(100, 30)
    draw(r, (view) => renderWelcome({ x: 0, y: 0, w: 100, h: 30 }, state, view, palette, GLYPHS))
    // menu at right column x=50: 'c' of ctrl+s at 50.
    expect(cellAt(r, 50, 1).style).toMatchObject(fg(palette.accentUser))
  })
})
