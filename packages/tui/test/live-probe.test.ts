// M47 G2: the LIVE /doctor probe — paint-suspend + parser-hook reply plumbing.
// The app's input path runs the REAL tui-core InputParser (the production
// wiring): its onOsc/onDcs hooks hand the probe replies to app.feedProbeReply
// (OSC/DCS payloads never become key events); the CSI answers (DA2/DECRPM)
// arrive as `unknown` events the parser cannot classify and are handled by the
// loop's unknown-CSI route. Asserts: query bytes through the write sink
// (ledger), ZERO frame writes while the suspend holds, panel fields refreshed,
// timeout release (≤800ms, no deadlock), and late replies still accepted
// (no second suspend).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, InputParser, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/index.ts"
import type { BackendClient, TuiEvent } from "../src/index.ts"

const cap0: TerminalCapabilityContext = {
  ...createUnknownCapabilities(),
  colorLevel: "truecolor",
  dark: false,
  brand: "WindowsTerminal",
  multiplexer: "none",
  kitty: false,
}
const palette = resolvePalette(cap0, "groknight")
const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap: cap0 })

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

describe("TuiApp — live /doctor probe (M47 G2)", () => {
  let r: Renderer
  beforeEach(() => {
    r = make(100, 24)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const makeApp = (write: (s: string) => void): TuiApp => new TuiApp({
    renderer: r,
    backend: stubBackend(),
    engine: createScrollbackEngine({ width: 100 }),
    capabilities: cap0,
    palette,
    glyphs: GLYPHS,
    write,
  })

  /** /doctor through the REAL submit path (the registry run). */
  const runDoctor = (app: TuiApp): void => {
    app.state().prompt.text = "/doctor"
    app.dispatch("submit")
  }

  /** The probe input path: real parser → hooks (feedProbeReply) + the key
   * event stream (feedInput) — mirrors apps/tui attachInput → TuiApp. */
  const probeInput = (app: TuiApp): { parser: InputParser; feed(ev: InputEvent): void } => {
    let queue: InputEvent[] = []
    const parser = new InputParser({
      onOsc: (p) => app.feedProbeReply(p),
      onDcs: (p) => app.feedProbeReply(p),
    })
    return {
      parser,
      feed: (ev) => {
        queue.push(ev)
        for (const e of queue) app.feedInput(e)
        queue = []
      },
    }
  }

  const rowsOf = (app: TuiApp): Array<{ label: string; detail?: string }> =>
    app.state().lightPanel?.rows ?? []

  it("arms the paint-suspend + writes the probe query bytes through the write sink", async () => {
    const ledger: string[] = []
    const app = makeApp((s) => ledger.push(s))
    runDoctor(app)
    await vi.advanceTimersByTimeAsync(0) // flush microtasks — Probing frame paints, probe arms
    // suspend active; the panel renders the Probing… state while it holds.
    expect(app.probeSuspend).toBeDefined()
    expect(app.probeSuspend!.reason).toContain("doctor")
    expect(app.probeSuspend!.until - Date.now()).toBeGreaterThanOrEqual(700)
    expect(app.state().lightPanel?.kind).toBe("doctor")
    expect(rowsOf(app)).toEqual([{ label: "Probing…" }])
    // queries arrive through the app's write sink (ledger-observable) —
    // byte-for-byte the tui-core probe's sweep.
    expect(ledger).toContain("\x1b[>0q")
    expect(ledger).toContain("\x1b[c")
    expect(ledger).toContain("\x1b[?27u")
    expect(ledger).toContain("\x1b]11;?\x07")
  })

  it("ZERO frame writes while the suspend holds; replies settle + refresh the panel", async () => {
    const ledger: string[] = []
    const app = makeApp((s) => ledger.push(s))
    runDoctor(app)
    await vi.advanceTimersByTimeAsync(0)
    expect(app.probeSuspend).toBeDefined()
    // No frame bytes during the window — not even the zero-byte idle "".
    const before = ledger.length
    app.frame()
    app.dispatch("scroll-down")
    app.dispatch("focus-prompt")
    await vi.advanceTimersByTimeAsync(0)
    expect(ledger.length).toBe(before)

    // The answers through the REAL parser path: DCS (XTVERSION) hangs on
    // onDcs, OSC (bg) on onOsc — both produce NO key events; the DECRPM CSI
    // arrives as an `unknown` event the key path used to drop.
    const { parser, feed } = probeInput(app)
    const events: InputEvent[] = []
    events.push(...parser.push("\x1bP>|kitty-0.30.0\x1b\\", cap0))
    events.push(...parser.push("\x1b]11;rgb:1010/1010/1010\x07", cap0))
    events.push(...parser.push("\x1b[?27;1$p", cap0))
    // ...and the parser's hooks fire inside push() — the event array must only
    // contain the CSI unknown (no key/paste events — replies never reach the
    // key stream).
    expect(events.map((e) => e.type)).toEqual(["unknown"])
    for (const ev of events) feed(ev)
    await vi.advanceTimersByTimeAsync(0)

    // All three answers → the run settles EARLY (no 800ms wait).
    expect(app.probeSuspend).toBeUndefined()
    expect(app.liveCapabilities().brand).toBe("kitty")
    expect(app.liveCapabilities().dark).toBe(true)
    expect(app.liveCapabilities().kitty).toBe(true)
    const rows = rowsOf(app)
    expect(rows.find((x) => x.label === "terminal")).toEqual({ label: "terminal", detail: "kitty" })
    expect(rows.find((x) => x.label === "dark")).toEqual({ label: "dark", detail: "yes" })
    expect(rows.find((x) => x.label === "kitty keyboard")).toEqual({ label: "kitty keyboard", detail: "yes" })
    expect(rows.some((x) => x.label === "Probing…")).toBe(false)
    // frames flow again after the release.
    app.frame()
    expect(ledger.length).toBeGreaterThan(before)
  })

  it("releases on the 800ms timeout when nothing answers (no deadlock)", async () => {
    const ledger: string[] = []
    const app = makeApp((s) => ledger.push(s))
    runDoctor(app)
    await vi.advanceTimersByTimeAsync(0)
    expect(app.probeSuspend).toBeDefined()
    await vi.advanceTimersByTimeAsync(PROBE_SUSPEND_MS_FOR_TEST)
    expect(app.probeSuspend).toBeUndefined()
    // the report reflects whatever the run merged (unanswered keeps the
    // previous knowledge — no defaults regression) — and no Probing… row.
    const rows = rowsOf(app)
    expect(rows.some((x) => x.label === "Probing…")).toBe(false)
    expect(rows.find((x) => x.label === "terminal")?.detail).toBe("WindowsTerminal")
    app.frame()
    expect(ledger.length).toBeGreaterThan(0)
  })

  it("accepts a reply AFTER the window — panel updates, no second suspend", async () => {
    const ledger: string[] = []
    const app = makeApp((s) => ledger.push(s))
    runDoctor(app)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(PROBE_SUSPEND_MS_FOR_TEST) // nothing answered → settle (timeout)
    expect(app.probeSuspend).toBeUndefined()
    expect(rowsOf(app).find((x) => x.label === "terminal")?.detail).toBe("WindowsTerminal")
    // The LATE XTVERSION answer (after the window) — accepted, panel refreshed,
    // suspend stays OFF.
    const { parser } = probeInput(app)
    parser.push("\x1bP>|wezterm-2026.0.0.2\x1b\\", cap0)
    await vi.advanceTimersByTimeAsync(0)
    expect(app.probeSuspend).toBeUndefined()
    expect(rowsOf(app).find((x) => x.label === "terminal")?.detail).toBe("wezterm")
    expect(app.liveCapabilities().brand).toBe("wezterm")
  })

  it("a second /doctor during an in-flight run shares it (no nested suspend)", async () => {
    const ledger: string[] = []
    const app = makeApp((s) => ledger.push(s))
    runDoctor(app)
    await vi.advanceTimersByTimeAsync(0)
    expect(app.probeSuspend).toBeDefined()
    runDoctor(app) // re-run while the first is in flight
    await vi.advanceTimersByTimeAsync(0)
    expect(app.probeSuspend).toBeDefined() // still the one window
    const { parser, feed } = probeInput(app)
    const evs = [
      ...parser.push("\x1b[?27;1$p", cap0),
      ...parser.push("\x1bP>|kitty-0.30.0\x1b\\", cap0),
      ...parser.push("\x1b]11;rgb:1010/1010/1010\x07", cap0),
    ]
    for (const ev of evs) feed(ev)
    await vi.advanceTimersByTimeAsync(0)
    expect(app.probeSuspend).toBeUndefined()
    expect(rowsOf(app).find((x) => x.label === "terminal")?.detail).toBe("kitty")
  })
})

const PROBE_SUSPEND_MS_FOR_TEST = 800
