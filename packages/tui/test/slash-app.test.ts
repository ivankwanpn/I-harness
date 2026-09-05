// M46a G2: THE LOOP — slash registry execution seam + keys-truth behaviors
// (stash round-trip, /find search mode, /theme palette re-resolve,
// /timestamps engine rows, /jump panel select) through real TuiApp dispatch.

import { describe, expect, it, beforeEach } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/index.ts"
import type { BackendClient, TuiEvent } from "../src/index.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
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
    events: async function* () {
      for (const ev of events) yield ev
    },
    seqCursor: () => 0,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
    context: async () => ({ used: 42, total: 1000 }),
  }
}

describe("TuiApp — M46a slash registry run + keys truth", () => {
  let r: Renderer
  beforeEach(() => {
    r = make(100, 24)
  })

  const makeApp = (): TuiApp => new TuiApp({
    renderer: r,
    backend: stubBackend(),
    engine: createScrollbackEngine({ width: 100 }),
    capabilities: cap,
    palette,
    glyphs: GLYPHS,
    write: () => {},
    now: () => 13_334,
  })

  it("Ctrl+S stash/pop round-trip (swap semantics)", () => {
    const app = makeApp()
    app.state().prompt.text = "first draft"
    app.state().prompt.cursor = 11
    app.dispatch("stash-draft")
    expect(app.state().draft).toBe("first draft")
    expect(app.state().prompt.text).toBe("")
    // type something new, then press again → restore
    app.state().prompt.text = "second"
    app.dispatch("stash-draft")
    expect(app.state().prompt.text).toBe("first draft")
    expect(app.state().draft).toBe("second")
    expect(app.state().prompt.cursor).toBe(11)
  })

  it("submit('/theme') runs the registry command (palette re-resolves + state flips)", () => {
    const app = makeApp()
    app.state().prompt.text = "/theme"
    app.dispatch("submit")
    expect(app.state().theme).toBe("groknight")
    app.state().prompt.text = "/theme"
    app.dispatch("submit")
    expect(app.state().theme).toBe("grokday")
  })

  it("submit('/timestamps') toggles the engine (existing rows gain a timestamp)", () => {
    const app = makeApp()
    const engine = app.state().engine
    engine.append({ type: "user", text: "hi", seq: 1, ts: 1_700_000_000_000 })
    engine.append({ type: "assistant", text: "ok", seq: 2, ts: 1_700_000_000_100 })
    expect(engine.viewport(0, 5).every((l) => l.timestamp === undefined)).toBe(true)
    app.state().prompt.text = "/timestamps"
    app.dispatch("submit")
    expect(app.state().timestamps).toBe(true)
    const rows = engine.viewport(0, 5)
    expect(rows[0]!.timestamp).toBeDefined()
  })

  it("submit('/find') starts the scrollback search (focused scrollback)", () => {
    const app = makeApp()
    app.state().prompt.text = "/find"
    app.dispatch("submit")
    expect(app.state().search?.active).toBe(true)
    expect(app.state().focused).toBe("scrollback")
  })

  it("submit('/history') opens the prompt-history panel (history exists)", () => {
    const app = makeApp()
    app.state().prompt.text = "hello there"
    app.dispatch("submit") // recorded into history + backend.submit (stub)
    app.state().prompt.text = "/history"
    app.dispatch("submit")
    expect(app.state().historyPanel?.entries[0]?.text).toBe("hello there")
  })

  it("submit('/jump') lists engine anchors; Enter selects → viewport jumps", () => {
    const app = makeApp()
    const engine = app.state().engine
    engine.append({ type: "user", text: "turn one", seq: 1, ts: 100 })
    engine.append({ type: "assistant", text: "answer", seq: 2, ts: 200 })
    app.state().prompt.text = "/jump"
    app.dispatch("submit")
    const panel = app.state().lightPanel
    expect(panel?.kind).toBe("jump")
    expect(panel?.rows.length).toBe(1)
    app.dispatch("overlay-select")
    expect(app.state().lightPanel).toBeUndefined()
    expect(app.state().scroll.follow).toBe(false)
  })

  it("submit('/usage') opens the token meter panel (real backend.context)", async () => {
    const app = makeApp()
    app.state().prompt.text = "/usage"
    app.dispatch("submit")
    await new Promise((r) => setTimeout(r, 0)) // the async run awaits backend.context
    expect(app.state().lightPanel?.kind).toBe("usage")
    expect(app.state().lightPanel?.rows.some((row) => row.label === "context used" && row.detail === "42")).toBe(true)
  })

  it("unknown '/x' falls through to the normal submit (history records the line)", () => {
    const app = makeApp()
    app.state().prompt.text = "/definitely-not-a-command"
    app.dispatch("submit")
    expect(app.state().history).toContain("/definitely-not-a-command")
  })

  it("/btw 'question' shows the btw overlay + steers the question", () => {
    const app = makeApp()
    let steered = ""
    const backend = stubBackend()
    backend.steer = async (t) => { steered = t }
    const app2 = new TuiApp({
      renderer: r, backend, engine: app.state().engine,
      capabilities: cap, palette, glyphs: GLYPHS, write: () => {}, now: () => 13_334,
    })
    app2.state().prompt.text = "/btw why?"
    app2.dispatch("submit")
    expect(app2.state().paneData?.btw?.question).toBe("why?")
    expect(steered).toBe("why?")
  })
})
