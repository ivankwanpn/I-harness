// M49 Task 7: the cursor state machine — Show/MoveTo/Hide transition bytes.
// THE test contract is literal (the PTY case-025 row): an unchanged target
// emits NOTHING (zero-byte idle), a move emits a bare MoveTo, hide emits
// `\x1b[?25l`. Show always precedes MoveTo. The `physical` second argument is
// the renderer's diff-end position — the transition accounts for the cell
// flush's own cursor displacement.

import { describe, expect, it } from "vitest"
import { createCursorState } from "../src/cursor/index.ts"
import type { CursorTarget } from "../src/cursor/index.ts"

describe("createCursorState — transition bytes", () => {
  it("writes Show/MoveTo once and emits nothing on an idle frame", () => {
    const cursor = createCursorState()
    expect(cursor.transition({ x: 4, y: 8, visible: true })).toBe("\x1b[?25h\x1b[9;5H")
    expect(cursor.transition({ x: 4, y: 8, visible: true })).toBe("")
    expect(cursor.transition({ x: 6, y: 8, visible: true })).toBe("\x1b[9;7H")
    expect(cursor.transition({ x: 6, y: 8, visible: false })).toBe("\x1b[?25l")
  })

  it("emits nothing before the first Show (the terminal starts hidden)", () => {
    const cursor = createCursorState()
    expect(cursor.transition({ x: 0, y: 0, visible: false })).toBe("")
    expect(cursor.transition({ x: 0, y: 0, visible: false })).toBe("")
  })

  it("hide→show at the same cell re-shows without a redundant MoveTo", () => {
    const cursor = createCursorState()
    cursor.transition({ x: 3, y: 2, visible: true }) // Show + MoveTo
    cursor.transition({ x: 3, y: 2, visible: false }) // Hide
    expect(cursor.transition({ x: 3, y: 2, visible: true })).toBe("\x1b[?25h")
  })

  it("a moved target while hidden only hides (no MoveTo for a hidden cursor)", () => {
    const cursor = createCursorState()
    cursor.transition({ x: 3, y: 2, visible: true })
    cursor.transition({ x: 3, y: 2, visible: false })
    expect(cursor.transition({ x: 9, y: 9, visible: false })).toBe("")
  })

  it("the renderer's diff-end physical position forces a MoveTo when it differs", () => {
    const cursor = createCursorState()
    // The diff ends at (10,5) while the target is (4,8) — the terminal cursor
    // was displaced by the cell flush and must be re-asserted.
    expect(cursor.transition({ x: 4, y: 8, visible: true }, { x: 10, y: 5 })).toBe("\x1b[?25h\x1b[9;5H")
    // The diff ends exactly AT the target — no bytes (the flush left the
    // physical cursor where the target wants it).
    expect(cursor.transition({ x: 4, y: 8, visible: true }, { x: 4, y: 8 })).toBe("")
  })

  it("invalidate forces the next visible MoveTo (resize)", () => {
    const cursor = createCursorState()
    cursor.transition({ x: 4, y: 8, visible: true })
    cursor.invalidate()
    expect(cursor.transition({ x: 4, y: 8, visible: true })).toBe("\x1b[9;5H")
  })
})

describe("CursorTarget", () => {
  it("is the {x,y,visible} cell contract", () => {
    const t: CursorTarget = { x: 0, y: 0, visible: false }
    expect(t).toEqual({ x: 0, y: 0, visible: false })
  })
})
