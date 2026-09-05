// M46b G1: the HitArea registry + HoverEngine — frame registration, the
// in/out change flag (dirty repaint rule), the topmost hitAt for G2's click
// router, and the reset gate (mouse path toggle).

import { describe, expect, it } from "vitest"
import { HoverEngine } from "../src/app/hover.ts"

const rect = { x: 2, y: 3, w: 10, h: 1 }

describe("HoverEngine", () => {
  it("registers areas per frame and settles the hovered flag on update", () => {
    const e = new HoverEngine()
    e.beginFrame()
    expect(e.hit(rect, "row-0")).toBe(false)
    e.update(5, 3) // inside row-0
    expect(e.hoveredSet().has("row-0")).toBe(true)

    // next frame: same id, fresh registration — the settled set persists.
    e.beginFrame()
    expect(e.hit(rect, "row-0")).toBe(true)
  })

  it("update returns changed ONLY on in/out transitions (the dirty flag)", () => {
    const e = new HoverEngine()
    e.beginFrame()
    e.addArea(rect, "a")
    e.addArea({ x: 20, y: 3, w: 8, h: 1 }, "b")
    expect(e.update(5, 3)).toBe(true) // in → a hovered
    expect(e.update(6, 3)).toBe(false) // still a; unchanged
    expect(e.update(22, 3)).toBe(true) // a out, b in
    expect(e.update(22, 3)).toBe(false)
    expect(e.update(0, 0)).toBe(true) // both out
  })

  it("hitAt returns the topmost (last-registered) area for G2's click router", () => {
    const e = new HoverEngine()
    e.beginFrame()
    e.addArea(rect, "big")
    e.addArea({ x: 4, y: 3, w: 3, h: 1 }, "small")
    expect(e.hitAt(5, 3)?.id).toBe("small") // overlap → most specific
    expect(e.hitAt(1, 3)).toBeUndefined()
    expect(e.hitAt(5, 4)).toBeUndefined() // row 4 outside h:1
  })

  it("hit() returns the flag in the same call (the view's visual switch)", () => {
    const e = new HoverEngine()
    e.beginFrame()
    e.hit(rect, "x") // settled false initially
    e.update(3, 3)
    e.beginFrame()
    expect(e.hit(rect, "x")).toBe(true)
  })

  it("reset clears registration + the settled set (mouse path off)", () => {
    const e = new HoverEngine()
    e.beginFrame()
    e.hit(rect, "x")
    e.update(3, 3)
    expect(e.hoveredSet().size).toBe(1)
    e.clear()
    expect(e.hoveredSet().size).toBe(0)
    e.beginFrame()
    expect(e.hit(rect, "x")).toBe(false)
  })

  it("label rides the area (semantic for the visuals)", () => {
    const e = new HoverEngine()
    e.beginFrame()
    e.addArea(rect, "chip-path", "cwd-copy")
    expect(e.hitAt(4, 3)?.label).toBe("cwd-copy")
  })

  it("row-0 exclusive rects respect the 1-based app-space convention", () => {
    const e = new HoverEngine()
    e.beginFrame()
    e.addArea(rect, "a")
    expect(e.hitAt(1, 2)).toBeUndefined() // row 2 is OUTSIDE y=3..4
    expect(e.hitAt(2, 3)?.id).toBe("a") // left edge inclusive
    expect(e.hitAt(12, 3)).toBeUndefined() // right edge exclusive (x+w = 12)
    expect(e.hitAt(11, 3)?.id).toBe("a") // last inside column
    expect(e.hitAt(2, 3)?.id).toBe("a")
  })
})
