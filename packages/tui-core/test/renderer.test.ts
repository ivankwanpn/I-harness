// M36 G4: renderer composition API — regression tests for the two
// PTY-harness footguns plus the resize full-paint and zero-byte idle contracts.
//
//   Footgun A: commit() is followed by flush() expecting the frame just drawn —
//              flush() must read the internal post-commit frame, never the
//              public `buffer` (which holds the PREVIOUS frame after commit).
//   Footgun B: the CursorTracker is carried across frames inside the renderer —
//              frame 2's row 0 must be addressed by an explicit CUP (a per-
//              render CursorTracker(0,0) would assume (0,0) and misplace it).

import { describe, expect, it } from "vitest"
import { attachInput, createRenderer, createTerminal } from "../src/index.ts"
import type { Renderer } from "../src/index.ts"
import { createUnknownCapabilities } from "../src/types.ts"
import type { TerminalCapabilityContext } from "../src/types.ts"
import type { Style } from "../src/ansi/style.ts"

const caps = (partial: Partial<TerminalCapabilityContext> = {}): TerminalCapabilityContext => ({
  ...createUnknownCapabilities(),
  ...partial,
})

const put = (r: Renderer, x: number, y: number, text: string, style: Style = {}): void => {
  r.buffer.put(x, y, { text, style, width: 1, continuation: false })
}

/** Strip CSI sequences — the remaining characters are the visible cells. */
const flatten = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")

describe("createRenderer (Footgun A: commit→flush emits the frame just drawn)", () => {
  it("draw → commit → flush emits the drawn text, never a blank full-frame", () => {
    const r = createRenderer({ cols: 5, rows: 3, cap: caps() })
    put(r, 0, 0, "a")
    put(r, 1, 0, "b")
    put(r, 2, 0, "c")
    r.commit()
    const writes: string[] = []
    const out = r.flush((s) => writes.push(s))
    expect(out).toBe("abc")
    expect(writes).toEqual(["abc"])
    // The buggy flush (reading the post-commit presenter) puts the whole frame
    // of padding spaces after the drawn cells — the visible content must be
    // EXACTLY the drawn text.
    expect(flatten(out)).toBe("abc")
  })

  it("a second commit→flush draws the NEXT frame from the same handle", () => {
    const r = createRenderer({ cols: 5, rows: 3, cap: caps() })
    put(r, 0, 0, "a")
    r.commit()
    r.flush(() => {})
    // redraw everything into the same handle (it holds the previous frame now)
    put(r, 0, 0, "x")
    put(r, 0, 1, "y")
    r.commit()
    const out = r.flush(() => {})
    expect(out).toBe("\x1b[1;1Hx\x1b[2;1Hy") // both changed cells, absolute CUPs
    expect(flatten(out)).toBe("xy")
  })

  it("unchanged commit → sameFrame() true, flush returns '' (zero-byte idle)", () => {
    const r = createRenderer({ cols: 5, rows: 3, cap: caps() })
    put(r, 0, 0, "a")
    r.commit()
    expect(r.sameFrame()).toBe(false)
    r.flush(() => {})
    put(r, 0, 0, "a")
    r.commit()
    expect(r.sameFrame()).toBe(true)
    const writes: string[] = []
    const out = r.flush((s) => writes.push(s))
    expect(out).toBe("")
    expect(writes).toEqual([])
  })
})

describe("createRenderer (Footgun B: cursor carried across frames)", () => {
  it("frame 2 row 0 is addressed by an explicit CUP (fresh (0,0) would misplace)", () => {
    const r = createRenderer({ cols: 5, rows: 3, cap: caps() })
    put(r, 0, 0, "a")
    put(r, 1, 0, "b")
    put(r, 2, 0, "c")
    r.commit()
    expect(r.flush(() => {})).toBe("abc") // tracker ends at (3,0) — not (0,0)

    put(r, 0, 0, "x")
    put(r, 1, 0, "y")
    put(r, 2, 0, "z")
    r.commit()
    const out = r.flush(() => {})
    expect(out.startsWith("\x1b[1;1H")).toBe(true)
    expect(out).toBe("\x1b[1;1Hxyz")
  })

  it("a run whose head is exactly where the carried cursor sits emits no CUP", () => {
    const r = createRenderer({ cols: 5, rows: 3, cap: caps() })
    put(r, 0, 0, "a")
    put(r, 1, 0, "b")
    put(r, 2, 0, "c")
    r.commit()
    r.flush(() => {}) // tracker: (3,0)
    // the move behind Footgun A: the handle holds the PREVIOUS frame after
    // commit — the app must redraw the whole frame (it does, like host-010)
    put(r, 0, 0, "a")
    put(r, 1, 0, "b")
    put(r, 2, 0, "c")
    put(r, 3, 0, "d")
    r.commit()
    expect(r.flush(() => {})).toBe("d") // adjacent delta: no reposition needed
  })
})

describe("createRenderer resize: next flush paints the full new area", () => {
  it("resize → commit → flush emits absolute CUPs for every row of the new grid", () => {
    const r = createRenderer({ cols: 5, rows: 3, cap: caps() })
    put(r, 0, 0, "a")
    r.commit()
    r.flush(() => {})

    r.resize(4, 2)
    put(r, 0, 0, "x")
    put(r, 0, 1, "y")
    r.commit()
    const out = r.flush(() => {})
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain("\x1b[")
    // full-area paint: every one of the 2×4 cells is addressed (a delta would
    // flatten to just "xy"); the first row CUP is forced by the resized tracker
    // (never assumes (0,0)).
    expect(flatten(out)).toBe("x   " + "y   ")
  })

  it("resize to the same content again still paints the full frame", () => {
    const r = createRenderer({ cols: 6, rows: 2, cap: caps() })
    put(r, 0, 0, "z")
    r.commit()
    r.flush(() => {})
    r.resize(6, 2)
    put(r, 0, 0, "z")
    r.commit()
    const out = r.flush(() => {})
    expect(out).toContain("\x1b[1;1H")
    expect(flatten(out)).toContain("z")
  })
})

describe("createRenderer validation and defaults", () => {
  it("is loud on misuse: cols<2, rows<1, missing cap, bad resize args", () => {
    expect(() => createRenderer({ cols: 1, rows: 3, cap: caps() })).toThrow(RangeError)
    expect(() => createRenderer({ cols: 5, rows: 0, cap: caps() })).toThrow(RangeError)
    expect(() => createRenderer({ cols: 0.5, rows: 3, cap: caps() })).toThrow(RangeError)
    expect(() => createRenderer({ cols: 5, rows: 3 } as never)).toThrow(TypeError)
    const r = createRenderer({ cols: 5, rows: 3, cap: caps() })
    expect(() => r.resize(1, 3)).toThrow(RangeError)
    expect(() => r.resize(4, 0)).toThrow(RangeError)
  })

  it("sync defaults to cap.synchronizedOutput; glyphs default to GLYPHS", () => {
    const r = createRenderer({ cols: 8, rows: 2, cap: caps({ synchronizedOutput: true }) })
    put(r, 0, 0, "z")
    r.commit()
    const out = r.flush(() => {})
    expect(out.startsWith("\x1b[?2026h")).toBe(true)
    expect(out.endsWith("\x1b[?2026l")).toBe(true)
    expect(r.glyphs.promptArrow).toBe("❯ ")
  })

  it("sync:false overrides a sync-capable terminal (no DEC 2026 wrapper)", () => {
    const r = createRenderer({ cols: 8, rows: 2, cap: caps({ synchronizedOutput: true }), sync: false })
    put(r, 0, 0, "z")
    r.commit()
    expect(r.flush(() => {})).toBe("z")
  })
})

describe("frozen surface: createTerminal / attachInput", () => {
  it("createTerminal init writes initSequence and returns it", () => {
    const writes: string[] = []
    const t = createTerminal({ stream: { write: (s) => (writes.push(s), true) }, cap: caps() })
    const bytes = t.init()
    expect(bytes).toBe("\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l")
    expect(writes).toEqual([bytes])
  })

  it("createTerminal teardown is one-shot: single write, repeat calls write nothing", () => {
    const writes: string[] = []
    const t = createTerminal({ stream: { write: (s) => (writes.push(s), true) }, cap: caps() })
    const bytes = t.teardown()
    expect(bytes.length).toBeGreaterThan(0)
    expect(writes).toEqual([bytes])
    writes.length = 0
    expect(t.teardown()).toBe("")
    expect(t.teardown()).toBe("")
    expect(writes).toEqual([])
  })

  it("createTerminal rejects a missing stream loudly", () => {
    expect(() => createTerminal({ stream: null as never })).toThrow(TypeError)
    expect(() => createTerminal({ stream: {} as never })).toThrow(TypeError)
    expect(() => createTerminal(null as never)).toThrow(TypeError)
  })

  it("attachInput start sets raw mode and forwards InputParser events; stop reverses", () => {
    const events: unknown[] = []
    const handlers = new Map<string, (d: unknown) => void>()
    const stdin = {
      isTTY: true,
      modes: false,
      setRawMode(m: boolean): void {
        this.modes = m
      },
      on(e: string, cb: (d: unknown) => void): void {
        handlers.set(e, cb)
      },
      off(e: string, cb: (d: unknown) => void): void {
        const cur = handlers.get(e)
        if (cur === cb) handlers.delete(e)
      },
    }
    const a = attachInput({ stdin, onEvent: (ev) => events.push(ev), cap: caps() })
    a.start()
    expect((stdin as unknown as { modes: boolean }).modes).toBe(true)
    const data = handlers.get("data")
    expect(data).toBeDefined()
    data!(new TextEncoder().encode("a"))
    expect(events).toEqual([{ type: "key", code: "char", key: "a", ctrl: false, alt: false, shift: false }])
    a.stop()
    expect((stdin as unknown as { modes: boolean }).modes).toBe(false)
    expect(handlers.has("data")).toBe(false)
    a.stop() // repeat stop is a no-op
  })

  it("attachInput is loud on misuse: no stdin / start on a non-tty", () => {
    expect(() => attachInput({ stdin: null as never, onEvent: () => {} })).toThrow(TypeError)
    expect(() => attachInput({ stdin: { isTTY: false, setRawMode: () => {}, on: () => {}, off: () => {} } as never, onEvent: () => {} }).start()).toThrow(TypeError)
  })
})
