// M36: flushRuns — dirty runs → ANSI byte stream (CUP/minimal SGR/width-safety/sync).
import { describe, expect, it } from "vitest"
import { CursorTracker, flushRuns } from "../src/render/index.ts"
import { CellBuffer } from "../src/grid/index.ts"
import { SgrState } from "../src/ansi/style.ts"
import { createUnknownCapabilities } from "../src/types.ts"
import type { DiffFrame } from "../src/grid/index.ts"
import type { TerminalCapabilityContext } from "../src/types.ts"
import type { Style } from "../src/ansi/style.ts"

const caps = (partial: Partial<TerminalCapabilityContext> = {}): TerminalCapabilityContext => ({
  ...createUnknownCapabilities(),
  ...partial,
})

const cell = (text: string, style: Style = {}, width: 1 | 2 = 1) => ({
  text,
  style,
  width,
  continuation: false,
})

function gridWithWidth(width: number, height = 1): CellBuffer {
  return new CellBuffer(width, height)
}

describe("flushRuns", () => {
  it("sameFrame → '' — zero bytes, even with sync on", () => {
    const grid = gridWithWidth(4)
    const frame: DiffFrame = { sameFrame: true, runs: [] }
    const out = flushRuns(frame, grid, {
      sync: true,
      sgr: new SgrState(),
      cap: caps({ synchronizedOutput: true }),
    })
    expect(out).toBe("")
  })

  it("empty runs → '' (cap.synchronizedOutput=false and dirty-empty still '' )", () => {
    const grid = gridWithWidth(4)
    const out = flushRuns(
      { sameFrame: false, runs: [] },
      grid,
      { sync: true, sgr: new SgrState(), cap: caps({ synchronizedOutput: true }) },
    )
    expect(out).toBe("")
  })

  it("dirty run at origin → cell text only (no CUP, no SGR)", () => {
    const grid = gridWithWidth(4)
    grid.put(0, 0, cell("a"))
    const out = flushRuns(
      { sameFrame: false, runs: [{ y: 0, x0: 0, x1: 0 }] },
      grid,
      { sync: false, sgr: new SgrState(), cap: caps() },
    )
    expect(out).toBe("a")
  })

  it("emits CUP when the rightmost-column run is not at cursor", () => {
    const grid = gridWithWidth(4)
    grid.put(0, 0, cell("a"))
    grid.put(2, 0, cell("c"))
    const out = flushRuns(
      {
        sameFrame: false,
        runs: [
          { y: 0, x0: 0, x1: 0 },
          { y: 0, x0: 2, x1: 2 },
        ],
      },
      grid,
      { sync: false, sgr: new SgrState(), cap: caps() },
    )
    expect(out).toBe("a\x1b[1;3Hc")
  })

  it("CUP on a later row start", () => {
    const grid = gridWithWidth(4, 3)
    grid.put(0, 1, cell("b"))
    const out = flushRuns(
      { sameFrame: false, runs: [{ y: 1, x0: 0, x1: 0 }] },
      grid,
      { sync: false, sgr: new SgrState(), cap: caps() },
    )
    expect(out).toBe("\x1b[2;1Hb")
  })

  it("sync on + dirty → wrapper present and output nonempty", () => {
    const grid = gridWithWidth(4)
    grid.put(0, 0, cell("a"))
    const out = flushRuns(
      { sameFrame: false, runs: [{ y: 0, x0: 0, x1: 0 }] },
      grid,
      { sync: true, sgr: new SgrState(), cap: caps({ synchronizedOutput: true }) },
    )
    expect(out.startsWith("\x1b[?2026h")).toBe(true)
    expect(out.endsWith("\x1b[?2026l")).toBe(true)
    expect(out).toBe("\x1b[?2026ha\x1b[?2026l")
  })

  it("sync on but cap.synchronizedOutput=false → no wrapper", () => {
    const grid = gridWithWidth(4)
    grid.put(0, 0, cell("a"))
    const out = flushRuns(
      { sameFrame: false, runs: [{ y: 0, x0: 0, x1: 0 }] },
      grid,
      { sync: true, sgr: new SgrState(), cap: caps({ colorLevel: "ansi16", dark: true }) },
    )
    expect(out).toBe("a")
  })

  it("sanitizes control bytes in cell text (escape-injection guard)", () => {
    const grid = gridWithWidth(10)
    grid.put(0, 0, cell("a\x1b[31mb\x9bc"))
    const out = flushRuns(
      { sameFrame: false, runs: [{ y: 0, x0: 0, x1: 0 }] },
      grid,
      { sync: false, sgr: new SgrState(), cap: caps() },
    )
    expect(out).toBe("a [31mb c")
    expect(out.includes("\x1b[31m")).toBe(false)
  })

  it("never starts a width-2 cell on the last column (space placeholder)", () => {
    const grid = gridWithWidth(4)
    grid.put(3, 0, cell("中", {}, 2))
    const out = flushRuns(
      { sameFrame: false, runs: [{ y: 0, x0: 3, x1: 3 }] },
      grid,
      { sync: false, sgr: new SgrState(), cap: caps() },
    )
    expect(out).toBe("\x1b[1;4H ")
    expect(out).not.toContain("中")
  })

  it("width-2 at W-2 advances the virtual cursor 2; next row run needs no CUP", () => {
    const grid = gridWithWidth(4, 2)
    grid.put(2, 0, cell("中", {}, 2))
    grid.put(0, 1, cell("a"))
    const out = flushRuns(
      {
        sameFrame: false,
        runs: [
          { y: 0, x0: 2, x1: 3 },
          { y: 1, x0: 0, x1: 0 },
        ],
      },
      grid,
      { sync: false, sgr: new SgrState(), cap: caps() },
    )
    // CUP to the run head, then 中 (wide) consumes through the last column —
    // the wrapper-believed cursor is (0,1), so the next-row run emits NO CUP.
    expect(out).toBe("\x1b[1;3H中a")
    expect(out).not.toContain("\x1b[2;1H")
  })

  it("wrap protection: a last-column write paired with a same-row CUP repositions", () => {
    const grid = gridWithWidth(4, 2)
    grid.put(3, 0, cell("b"))
    grid.put(1, 0, cell("d"))
    const out = flushRuns(
      {
        sameFrame: false,
        runs: [
          { y: 0, x0: 3, x1: 3 },
          { y: 0, x0: 1, x1: 1 },
        ],
      },
      grid,
      { sync: false, sgr: new SgrState(), cap: caps() },
    )
    // full-row write wraps virtually to (0,1): the same-row run at x=1 must CUP
    // (and never a next-row CUP).
    expect(out).toBe("\x1b[1;4Hb\x1b[1;2Hd")
    expect(out).not.toContain("\x1b[2;1H")
  })

  it("emits minimal SGR per run and resets between styles", () => {
    const grid = gridWithWidth(4)
    grid.put(0, 0, cell("a", { fg: { idx: 1 } }))
    grid.put(1, 0, cell("b", { fg: { idx: 1 } }))
    grid.put(2, 0, cell("c", { fg: { idx: 2 } }))
    const out = flushRuns(
      {
        sameFrame: false,
        runs: [
          { y: 0, x0: 0, x1: 1 },
          { y: 0, x0: 2, x1: 2 },
        ],
      },
      grid,
      { sync: false, sgr: new SgrState(), cap: caps() },
    )
    // run 1: SGR red once for both cells; run 2 SGR green
    expect(out).toBe("\x1b[31mab\x1b[32mc")
  })

  it("startX/startY seed the assumed cursor position", () => {
    const grid = gridWithWidth(4)
    grid.put(0, 0, cell("a"))
    // cursor assumed NOT at the run head → CUP
    const out = flushRuns(
      { sameFrame: false, runs: [{ y: 0, x0: 0, x1: 0 }] },
      grid,
      { sync: false, sgr: new SgrState(), cap: caps(), startX: 0, startY: 1 },
    )
    expect(out).toBe("\x1b[1;1Ha")
    // assumed cursor already at the run head → no CUP
    const grid2 = gridWithWidth(4, 2)
    grid2.put(2, 1, cell("a"))
    const out2 = flushRuns(
      { sameFrame: false, runs: [{ y: 1, x0: 2, x1: 2 }] },
      grid2,
      { sync: false, sgr: new SgrState(), cap: caps(), startX: 2, startY: 1 },
    )
    expect(out2).toBe("a")
  })
})

describe("CursorTracker", () => {
  it("tracks virtual position and wrap", () => {
    const t = new CursorTracker(4, 3, 0)
    expect(t.isAt(3, 0)).toBe(true)
    t.advance(1) // writing the last column wraps
    expect(t.isAt(0, 1)).toBe(true)
    const t2 = new CursorTracker(4, 2, 0)
    t2.advance(2) // width-2 at W-2 consumes through the last column
    expect(t2.isAt(0, 1)).toBe(true)
    const t3 = new CursorTracker(10)
    t3.advance(2)
    expect(t3.isAt(2, 0)).toBe(true)
  })

  it("move repositions absolutely", () => {
    const t = new CursorTracker(10)
    t.move(4, 2)
    expect(t.isAt(4, 2)).toBe(true)
  })
})
