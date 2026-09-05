// M46b G1: the LOOP mouse path — the wheel stream replaces the M40 ±3 (one
// event on ept=3 = 1 line; follow-aware apply), Moved motion updates the last
// pointer + settles the hover set, the mouse.enabled gate drops everything
// while off (the mouse-reporting toggle), and Ctrl+R binds only with the
// mouseToggleFeature option (pure keys coverage).

import { describe, expect, it, beforeEach } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/index.ts"
import type { BackendClient, TuiEvent } from "../src/index.ts"
import { dispatchKey } from "../src/app/keys.ts"
import type { KeymapState } from "../src/app/keys.ts"

const cap: TerminalCapabilityContext = {
  ...createUnknownCapabilities(),
  colorLevel: "truecolor",
  dark: true,
  brand: "WindowsTerminal", // ept=3 profile
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

describe("TuiApp — M46b G1 mouse path", () => {
  let r: Renderer
  beforeEach(() => {
    r = make(46, 24)
  })

  const makeApp = (opts: Partial<ConstructorParameters<typeof TuiApp>[0]> = {}): TuiApp => new TuiApp({
    renderer: r,
    backend: stubBackend(),
    engine: createScrollbackEngine({ width: 46 }),
    capabilities: cap,
    palette,
    glyphs: GLYPHS,
    write: () => {},
    now: () => 13_334, // frozen clock — the stream flushes per event regardless
    ...opts,
  })

  const wheelEv = (btn: "wheel-up" | "wheel-down", x = 5, y = 5): InputEvent => ({
    type: "mouse", x, y, button: btn, drag: false, released: false, motion: false,
    mods: { ctrl: false, shift: false, alt: false },
  })
  const moveEv = (x: number, y: number): InputEvent => ({
    type: "mouse", x, y, button: "left", drag: false, released: false, motion: true,
    mods: { ctrl: false, shift: false, alt: false },
  })

  it("one wheel event scrolls ONE line (stream pricing, follow-aware)", () => {
    const app = makeApp()
    const engine = app.state().engine
    // 30 lines in a 24-row renderer: the follow clamp max = 30-24+1 = 7 —
    // enough room for the stream's 1-line deltas to land.
    for (let i = 0; i < 30; i++) engine.append({ type: "user", text: `row-${i}`, seq: i + 1, ts: i })
    app.feedInput(wheelEv("wheel-down"))
    expect(app.state().scroll.offset).toBe(7) // follow → clamp max, then clamped
    expect(app.state().scroll.follow).toBe(false)
    app.feedInput(wheelEv("wheel-up"))
    expect(app.state().scroll.offset).toBe(6)
  })

  it("Moved motion updates the last pointer (app-space 1-based → 0-based)", () => {
    const app = makeApp()
    app.feedInput(moveEv(5, 5))
    expect(app.state().mouse!.last).toEqual({ col: 4, row: 4 })
  })

  it("toggle flips the gate; while off every mouse event is dropped", () => {
    const app = makeApp()
    expect(app.state().mouse!.enabled).toBe(true)
    app.dispatch("toggle-mouse-reporting")
    expect(app.state().mouse!.enabled).toBe(false)
    app.state().engine.append({ type: "user", text: "row", seq: 1, ts: 0 })
    app.feedInput(wheelEv("wheel-down"))
    app.feedInput(moveEv(5, 5))
    expect(app.state().scroll.offset).toBe(0) // the stream never saw the event
    expect(app.state().mouse!.last).toEqual({ col: 0, row: 0 })
  })
})

describe("keys — Ctrl+R mouse-reporting binding gate (M46b G1)", () => {
  const base = (over: Partial<KeymapState> = {}): KeymapState => ({
    focused: "scrollback",
    promptText: "",
    multiLine: false,
    turnRunning: false,
    armedQuit: false,
    searchActive: false,
    ...over,
  })
  const ctrlR = { code: "char", key: "r", ctrl: true, alt: false, shift: false }

  it("binds toggle-mouse-reporting ONLY when the feature flag is on", () => {
    expect(dispatchKey(ctrlR, base())).toBe("none")
    expect(dispatchKey(ctrlR, base({ mouseToggle: true }))).toBe("toggle-mouse-reporting")
  })

  it("prompt-focused Ctrl+R stays 'none' (the binding is scrollback-only per grok)", () => {
    expect(dispatchKey(ctrlR, base({ focused: "prompt", mouseToggle: true }))).toBe("none")
  })
})
