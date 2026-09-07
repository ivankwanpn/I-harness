// M46a G2: THE LOOP — slash registry execution seam + keys-truth behaviors
// (stash round-trip, /find search mode, /theme palette re-resolve,
// /timestamps engine rows, /jump panel select) through real TuiApp dispatch.

import { describe, expect, it, beforeEach } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/index.ts"
import type { BackendClient, TuiEvent } from "../src/index.ts"
import { unsupportedSessionManagement } from "./backend-stub.ts"
import { recordingBackend, slashApp } from "./slash-fixtures.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

function stubBackend(): BackendClient {
  const events: TuiEvent[] = []
  return {
    ...unsupportedSessionManagement,
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
    expect(app.state().theme).toBe("grok-night")
    app.state().prompt.text = "/theme"
    app.dispatch("submit")
    expect(app.state().theme).toBe("grok-day")
    app.state().prompt.text = "/theme tokyo-night"
    app.dispatch("submit")
    expect(app.state().theme).toBe("tokyo-night")
    expect(app.state().theme).not.toBe("auto")
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

  it("unknown '/x' renders the exact Unsupported command toast and never submits", async () => {
    const backend = stubBackend()
    const submissions: string[] = []
    backend.submit = async (t) => { submissions.push(t) }
    const app2 = new TuiApp({
      renderer: r, backend, engine: createScrollbackEngine({ width: 100 }),
      capabilities: cap, palette, glyphs: GLYPHS, write: () => {}, now: () => 13_334,
    })
    app2.state().prompt.text = "/definitely-not-a-command"
    app2.dispatch("submit")
    expect(app2.state().toasts.at(-1)?.text).toBe("Unsupported command: /definitely-not-a-command")
    expect(submissions).toEqual([])
    expect(app2.state().history).not.toContain("/definitely-not-a-command")
  })

  it("never submits an excluded slash command to the model (the exact toast contract)", async () => {
    const { backend, submissions } = recordingBackend()
    const app = slashApp(backend)
    app.editor.replaceAll("/login")
    await app.submitPrompt()
    expect(app.toast).toBe("Unsupported command: /login")
    expect(submissions).toEqual([])
  })

  it("slash commands hidden by an absent capability are Unsupported too", async () => {
    const { backend, submissions } = recordingBackend()
    const app = slashApp(backend)
    app.editor.replaceAll("/rewind") // recordingBackend has no rewind member
    await app.submitPrompt()
    expect(app.toast).toBe("Unsupported command: /rewind")
    expect(submissions).toEqual([])
  })

  it("a capability-absent G1 modal (/provider) renders the unsupported contract too", async () => {
    const { backend, submissions } = recordingBackend() // no provider controller
    const app = slashApp(backend)
    app.editor.replaceAll("/provider")
    await app.submitPrompt()
    expect(app.toast).toBe("Unsupported command: /provider")
    expect(submissions).toEqual([])
  })

  it("a host startup prompt that starts with / is never submitted either", async () => {
    const { backend, submissions } = recordingBackend()
    const app = slashApp(backend)
    await app.app.initialize({ prompt: "/login", sessionId: "s" })
    expect(submissions).toEqual([])
    expect(app.toast).toBe("Unsupported command: /login")
  })

  it("the runtime mouse toggle writes the 5-mode disable/enable bytes on transitions only", () => {
    const capM: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true, mouse: true }
    const renderer = createRenderer({ cols: 100, rows: 24, cap: capM })
    const written: string[] = []
    const tui = new TuiApp({
      renderer,
      backend: recordingBackend().backend,
      engine: createScrollbackEngine({ width: 100 }),
      capabilities: capM,
      palette: resolvePalette(capM, "groknight"),
      glyphs: GLYPHS,
      write: (s: string) => { written.push(s) },
      now: () => 13_334,
      mouseToggleFeature: true,
    })
    const DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l"
    const ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h"
    const counts = (s: string): { off: number; on: number } => ({
      off: s.split(DISABLE).length - 1,
      on: s.split(ENABLE).length - 1,
    })
    // capture starts ON (the host initialized it) → first toggle = OFF bytes
    // (the write sink ALSO carries frame bytes — assert the sequence counts).
    tui.dispatch("toggle-mouse-reporting")
    expect(tui.state().mouse?.enabled).toBe(false)
    expect(counts(written.join(""))).toEqual({ off: 1, on: 0 })
    tui.dispatch("toggle-mouse-reporting") // ON
    tui.dispatch("toggle-mouse-reporting") // OFF
    expect(counts(written.join(""))).toEqual({ off: 2, on: 1 })
  })

  it("input precedence: a permission overlay answers BEFORE an open viewer (spec §9.4)", () => {
    const app = makeApp()
    const engine = app.state().engine
    engine.append({
      type: "tool", callId: "c1", name: "read-file", kind: "read", status: "done",
      summary: "read 1 file", output: "ok", seq: 1, ts: 100,
    })
    app.state().focused = "scrollback"
    app.feedInput({ type: "key", code: "Enter", key: "Enter", ctrl: false, alt: false, shift: false })
    expect(app.state().modal?.kind).toBe("block-viewer")
    const acts: Array<{ type: "overlay-accept"; index: number } | string> = []
    app.state().overlay = {
      kind: "permission",
      draw: () => {},
      act: (a: never) => acts.push(a),
      setCursor: () => {},
      rowYs: () => [0, 1],
    } as never
    // The digit answers the PERMISSION (tier 1) — never the viewer.
    app.feedInput({ type: "key", code: "char", key: "3", ctrl: false, alt: false, shift: false })
    expect(acts).toEqual([{ type: "overlay-accept", index: 3 }])
    expect(app.state().modal?.kind).toBe("block-viewer") // the viewer stays open underneath
  })

  it("input precedence: the viewer consumes keys before panes/prompt/scrollback", () => {
    const app = makeApp()
    const engine = app.state().engine
    engine.append({
      type: "tool", callId: "c2", name: "read-file", kind: "read", status: "done",
      summary: "x", output: "ok", seq: 1, ts: 100,
    })
    app.state().focused = "scrollback"
    app.feedInput({ type: "key", code: "Enter", key: "Enter", ctrl: false, alt: false, shift: false })
    expect(app.state().modal?.kind).toBe("block-viewer")
    app.state().prompt.text = "draft"
    app.feedInput({ type: "key", code: "char", key: "a", ctrl: false, alt: false, shift: false })
    expect(app.state().prompt.text).toBe("draft") // the char never reached the editor
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
