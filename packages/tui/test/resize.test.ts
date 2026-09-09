// M59: a terminal resize must repaint. The relay resized the renderer + engine
// but never requested a frame, so the layout kept the OLD geometry until the
// next input/event (grok reflows immediately).
import { describe, expect, it, vi } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import { unsupportedSessionManagement } from "./backend-stub.ts"
import type { BackendClient, TuiEvent } from "../src/contracts.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

function stubBackend(): BackendClient {
  return {
    ...unsupportedSessionManagement,
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    events: async function* (): AsyncIterable<TuiEvent> {},
    seqCursor: () => 0,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  }
}

describe("setSize repaints (M59)", () => {
  it("requests a frame after a resize (no waiting for the next input)", async () => {
    const renderer = createRenderer({ cols: 80, rows: 24, cap })
    const app = new TuiApp({
      renderer,
      backend: stubBackend(),
      engine: createScrollbackEngine({ width: 80 }),
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: () => {},
      now: () => 0,
    })
    const spy = vi.spyOn(app, "frame")
    app.setSize(60, 20)
    await new Promise((r) => setTimeout(r, 0)) // requestFrame defers via queueMicrotask
    expect(spy).toHaveBeenCalled()
  })
})
