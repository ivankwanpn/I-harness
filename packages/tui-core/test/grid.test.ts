// M36: cell grid + two-buffer diff.
import { describe, expect, it } from "vitest"
import { CellBuffer, DiffBuffer } from "../src/grid/index.ts"
import type { Cell } from "../src/grid/index.ts"
import type { Style } from "../src/ansi/style.ts"

const cell = (text: string, style: Style = {}): Cell => ({ text, style, width: 1, continuation: false })
const wide = (text: string, style: Style = {}): Cell => ({ text, style, width: 2, continuation: false })

describe("CellBuffer", () => {
  it("put stores row-major and sets the continuation half", () => {
    const b = new CellBuffer(2, 1)
    b.put(0, 0, wide("中"))
    expect(b.cells[0].text).toBe("中")
    expect(b.cells[0].width).toBe(2)
    expect(b.cells[0].continuation).toBe(false)
    expect(b.cells[1].text).toBe("")
    expect(b.cells[1].width).toBe(2)
    expect(b.cells[1].continuation).toBe(true)
    expect(b.cells[1].style).toBe(b.cells[0].style)
  })

  it("clear resets to blanks", () => {
    const b = new CellBuffer(2, 2)
    b.put(1, 1, cell("a"))
    b.clear()
    expect(b.cells).toHaveLength(4)
    expect(b.cells.every((c) => c.text === " " && c.width === 1 && c.continuation === false)).toBe(true)
  })

  it("put ignores out-of-bounds", () => {
    const b = new CellBuffer(2, 2)
    b.put(-1, 0, cell("a"))
    b.put(0, 2, cell("a"))
    b.put(2, 0, cell("a"))
    b.put(0, -1, cell("a"))
    expect(b.cells[0].text).toBe(" ")
  })

  it("snapshot returns a copy", () => {
    const b = new CellBuffer(1, 1)
    b.put(0, 0, cell("a"))
    const snap = b.snapshot()
    b.clear()
    expect(snap[0].text).toBe("a")
    expect(snap).not.toBe(b.cells)
  })
})

describe("DiffBuffer", () => {
  it("full-frame first draw → one run per differing region", () => {
    const d = new DiffBuffer(4, 1)
    const p = d.presenter()
    p.put(0, 0, cell("a"))
    const first = d.commit()
    expect(first.sameFrame).toBe(false)
    expect(first.runs).toEqual([{ y: 0, x0: 0, x1: 0 }])
  })

  it("one-cell change → single run", () => {
    const d = new DiffBuffer(4, 1)
    const p = d.presenter()
    p.clear()
    p.put(0, 0, cell("a"))
    d.commit()
    p.clear()
    p.put(0, 0, cell("a"))
    p.put(2, 0, cell("b"))
    const f = d.commit()
    expect(f.sameFrame).toBe(false)
    expect(f.runs).toEqual([{ y: 0, x0: 2, x1: 2 }])
  })

  it("100×50 grid with 3 changes → 3 runs", () => {
    const d = new DiffBuffer(100, 50)
    const p = d.presenter()
    p.clear()
    p.put(1, 1, cell("a"))
    p.put(50, 25, cell("b"))
    p.put(99, 49, cell("c"))
    d.commit()
    p.clear()
    p.put(1, 1, cell("a"))
    p.put(50, 25, cell("x"))
    p.put(99, 49, cell("d"))
    p.put(0, 0, cell("y"))
    const f = d.commit()
    expect(f.sameFrame).toBe(false)
    expect(f.runs).toEqual([
      { y: 0, x0: 0, x1: 0 },
      { y: 25, x0: 50, x1: 50 },
      { y: 49, x0: 99, x1: 99 },
    ])
  })

  it("same frame → sameFrame true, zero runs", () => {
    const d = new DiffBuffer(4, 3)
    const p = d.presenter()
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) p.put(x, y, cell("z"))
    }
    d.commit()
    p.clear()
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) p.put(x, y, cell("z"))
    }
    const f = d.commit()
    expect(f.sameFrame).toBe(true)
    expect(f.runs).toEqual([])
  })

  it("redrawing identical content between commits → sameFrame true", () => {
    const d = new DiffBuffer(3, 2)
    const p = d.presenter()
    p.put(0, 0, cell("a"))
    expect(d.commit().sameFrame).toBe(false) // first draw against the blank frame
    p.clear()
    p.put(0, 0, cell("a"))
    expect(d.commit().sameFrame).toBe(true)
  })

  it("changing the left cell of a width-2 pair covers x..x+1", () => {
    const d = new DiffBuffer(6, 1)
    const p = d.presenter()
    p.put(1, 0, wide("中"))
    d.commit()
    p.clear()
    p.put(1, 0, wide("日"))
    const f = d.commit()
    expect(f.sameFrame).toBe(false)
    expect(f.runs).toEqual([{ y: 0, x0: 1, x1: 2 }])
  })

  it("moving a wide char shifts continuation state correctly", () => {
    const d = new DiffBuffer(6, 1)
    const p = d.presenter()
    p.put(1, 0, wide("中"))
    d.commit()
    p.clear()
    p.put(3, 0, wide("中"))
    const f = d.commit()
    expect(f.sameFrame).toBe(false)
    // x1/x2 (old head+continuation) and x3/x4 (new head+continuation) differ
    expect(f.runs).toEqual([{ y: 0, x0: 1, x1: 4 }])
  })

  it("style-only change on a single cell produces a run", () => {
    const d = new DiffBuffer(4, 1)
    const p = d.presenter()
    p.put(0, 0, cell("a"))
    d.commit()
    p.clear()
    p.put(0, 0, cell("a", { fg: { idx: 1 } }))
    const f = d.commit()
    expect(f.runs).toEqual([{ y: 0, x0: 0, x1: 0 }])
  })

  it("per-row runs: full-frame draw spans each row", () => {
    const d = new DiffBuffer(3, 2)
    const p = d.presenter()
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) p.put(x, y, cell("x"))
    const f = d.commit()
    expect(f.sameFrame).toBe(false)
    expect(f.runs).toEqual([
      { y: 0, x0: 0, x1: 2 },
      { y: 1, x0: 0, x1: 2 },
    ])
  })
})
