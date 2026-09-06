import { afterEach, describe, expect, it, vi } from "vitest"
import { createRenderer, createUnknownCapabilities, makeGlyphs, resolvePalette } from "@i-harness/tui-core"
import { TuiApp, createScrollbackEngine } from "../src/index.ts"
import type { BackendClient, TuiEvent } from "../src/index.ts"
import { unsupportedSessionManagement } from "./backend-stub.ts"

const cap = { ...createUnknownCapabilities(), colorLevel: "truecolor" as const, dark: true }

function backend(close: () => Promise<void>): BackendClient {
  return {
    ...unsupportedSessionManagement,
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    events: async function* (): AsyncIterable<TuiEvent> {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close,
  }
}

describe("TuiApp quit error handling", () => {
  afterEach(() => { vi.restoreAllMocks() })

  it("handles a backend close rejection without an unhandled rejection", async () => {
    const closeError = new Error("flush failed")
    let closeCalls = 0
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    const app = new TuiApp({
      renderer: createRenderer({ cols: 80, rows: 24, cap }),
      backend: backend(async () => { closeCalls++; throw closeError }),
      engine: createScrollbackEngine({ width: 80 }),
      capabilities: cap,
      palette: resolvePalette(cap),
      glyphs: makeGlyphs(true),
    })
    process.on("unhandledRejection", onUnhandled)
    try {
      app.dispatch("quit")
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(closeCalls).toBe(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})
