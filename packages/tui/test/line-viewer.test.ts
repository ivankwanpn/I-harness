// M47 G2: openLineViewer wiring — prompt file-ref double-click through the REAL
// loop (mouse router → loop.openLineViewer): a ref naming an existing
// read/tool block opens the block viewer (light panel, kind "line-viewer",
// rows from the matched line, cursor at the ref line, Enter jumps the
// scrollback); a ref in no block keeps the honest toast. The host seam
// (TuiAppOptions.openLineViewer) stays first-priority.

import { describe, expect, it, beforeEach } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/index.ts"
import type { BackendClient, ScrollbackEngine, TuiEvent } from "../src/index.ts"
import { layoutAgent } from "../src/views/agent.ts"

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

const mouseEv = (x: number, y: number, released: boolean): InputEvent => ({
  type: "mouse", x, y, button: "left", drag: false, released, motion: false,
  mods: { ctrl: false, shift: false, alt: false },
})

describe("TuiApp — openLineViewer wiring (M47 G2)", () => {
  let r: Renderer
  beforeEach(() => {
    r = make(100, 24)
  })

  const engineWithRead = (): ScrollbackEngine => {
    const eng = createScrollbackEngine({ width: 100 })
    eng.append({ type: "tool", callId: "c1", name: "read", kind: "read", status: "done", summary: "src/app/mouse.ts", output: "1: one\n2: two\n3: three\n4: four\n5: five\n6: six\n7: seven\n8: eight\n9: nine\n10: ten", seq: 1, ts: 1 })
    return eng
  }

  const makeApp = (opts: Partial<ConstructorParameters<typeof TuiApp>[0]> = {}): TuiApp => new TuiApp({
    renderer: r,
    backend: stubBackend(),
    engine: engineWithRead(),
    capabilities: cap,
    palette,
    glyphs: GLYPHS,
    write: () => {},
    now: () => 13_334, // frozen clock — the multi-click window always holds
    ...opts,
  })

  const doubleClickRef = (app: TuiApp, text: string, ref: string): void => {
    const area = { cols: 100, rows: 24 }
    const rect = layoutAgent(area, { ...app.state(), dropdown: undefined }, { compact: false }).prompt
    const row = rect.y + 1
    const col = rect.x + 1 + 2 + text.indexOf(ref) + 1
    // two down+up gestures at the same cell (the parser's press/release pair —
    // the router's multi-click window holds on the frozen clock).
    app.feedInput(mouseEv(col + 1, row + 1, false))
    app.feedInput(mouseEv(col + 1, row + 1, true))
    app.feedInput(mouseEv(col + 1, row + 1, false))
    app.feedInput(mouseEv(col + 1, row + 1, true))
  }

  it("a file ref naming a Read block opens the block viewer at the matched line", () => {
    const app = makeApp()
    const text = "see src/app/mouse.ts:42 please"
    app.state().prompt.text = text
    doubleClickRef(app, text, "src/app/mouse.ts")
    const lp = app.state().lightPanel
    expect(lp).toBeDefined()
    expect(lp!.kind).toBe("line-viewer")
    expect(lp!.title).toBe("Read src/app/mouse.ts")
    expect(lp!.rows.length).toBeGreaterThan(1) // the block body rows from the matched line
    expect(lp!.rows[0]?.label).toContain("Read")
    // cursor at the ref line (42 → clamped to the window's last row).
    const body = lp!.rows.length
    expect(lp!.cursor).toBe(body - 1) // the ref line index clamps to the last window row
    // Enter → the scrollback viewport jumps to the matched row and the panel closes.
    app.dispatch("overlay-select")
    expect(app.state().lightPanel).toBeUndefined()
    expect(app.state().scroll.follow).toBe(false)
  })

  it("the host openLineViewer seam keeps first priority", () => {
    const opened: Array<{ file: string; line?: number }> = []
    const app = makeApp({ openLineViewer: (file, line) => opened.push({ file, ...(line !== undefined ? { line } : {}) }) })
    const text = "see src/app/mouse.ts:7 please"
    app.state().prompt.text = text
    doubleClickRef(app, text, "src/app/mouse.ts")
    expect(opened).toEqual([{ file: "src/app/mouse.ts", line: 7 }])
    expect(app.state().lightPanel).toBeUndefined()
  })

  it("a ref in NO block keeps the honest toast", () => {
    const app = makeApp()
    const text = "see src/never-wasm.ts:3 please"
    app.state().prompt.text = text
    doubleClickRef(app, text, "src/never-wasm.ts")
    expect(app.state().lightPanel).toBeUndefined()
    expect(app.state().toasts.some((t) => t.text.includes("line viewer") && t.text.includes("never-wasm"))).toBe(true)
  })

  it("the engine line walk finds execute blocks too (Run header path)", () => {
    const eng = createScrollbackEngine({ width: 100 })
    eng.append({ type: "tool", callId: "c1", name: "execute", kind: "execute", status: "done", summary: "python src/make-grid.py", output: "ok", seq: 1, ts: 1 })
    const app = makeApp({ engine: eng })
    const text = "run src/make-grid.py"
    app.state().prompt.text = text
    doubleClickRef(app, text, "src/make-grid.py")
    expect(app.state().lightPanel?.kind).toBe("line-viewer")
    expect(app.state().lightPanel?.title).toBe("Run python src/make-grid.py")
  })
})
