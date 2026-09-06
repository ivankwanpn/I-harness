// M49 Task 11 — the queue pane over a REAL app (fixtures per the plan's Test
// Fixture Contract): queueBackend = a recording BackendClient with real
// in-memory queue snapshots and cancel mutation; testOptions = real renderer,
// engine, palette, glyphs and write sink around the supplied backend (no
// mocked presenter); screenText() reads the actual virtual renderer cells.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import type { BackendClient, SessionQueueItem } from "../src/contracts.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")
const CANVAS = { cols: 100, rows: 24 }

let lastRenderer: Renderer | undefined

/** Read the actual virtual renderer cells (row-wise, trailing spaces trimmed). */
function screenText(): string {
  const r = lastRenderer!
  const cells = r.buffer.cells
  const w = r.buffer.width
  const h = r.buffer.height
  const lines: string[] = []
  for (let y = 0; y < h; y++) {
    let line = ""
    for (let x = 0; x < w; x++) line += cells[y * w + x].text
    lines.push(line.replace(/\s+$/, ""))
  }
  return lines.join("\n")
}

/** Real TuiApp options: real renderer/engine/palette/glyphs/write + backend. */
function testOptions(opts: { backend: BackendClient }): ConstructorParameters<typeof TuiApp>[0] {
  const r = createRenderer({ cols: CANVAS.cols, rows: CANVAS.rows, cap })
  lastRenderer = r
  return {
    renderer: r,
    backend: opts.backend,
    engine: createScrollbackEngine({ width: CANVAS.cols }),
    capabilities: cap,
    palette,
    glyphs: GLYPHS,
    write: () => {},
    now: () => 0,
  }
}

/** Recording BackendClient with real in-memory queue snapshots + cancel mutation. */
function queueBackend(initial: SessionQueueItem[] = []): BackendClient & {
  readonly cancelled: string[]
} {
  const items = new Map(initial.map((item) => [item.id, { ...item }]))
  const cancelled: string[] = []
  const backend: BackendClient & { readonly cancelled: string[] } = {
    cancelled,
    listSessions: async () => [],
    open: async () => {},
    modelState: async () => ({ status: "unconfigured", reason: "No model configured" }),
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    events: async function* () { /* never ends — the app closes instead */ },
    seqCursor: () => 0,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
    async queue() {
      return [...items.values()]
    },
    async cancelQueued(id) {
      if (!items.has(id)) return { cancelled: false }
      items.delete(id)
      cancelled.push(id)
      return { cancelled: true }
    },
  }
  return backend
}

/** Backend with NO queue capability (an honest degrading host). */
function noQueueBackend(): BackendClient {
  return {
    listSessions: async () => [],
    open: async () => {},
    modelState: async () => ({ status: "unconfigured", reason: "No model configured" }),
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    events: async function* () { /* never ends — the app closes instead */ },
    seqCursor: () => 0,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  }
}

describe("queue pane over the real app (Task 11)", () => {
  it("renders live queue rows and removes a cancelled row after refresh (backend truth)", async () => {
    const backend = queueBackend([
      { id: "q1", text: "second prompt", delivery: "queue", intent: "user", state: "queued", order: 2 },
    ])
    const app = new TuiApp(testOptions({ backend }))
    await app.openQueue()
    app.frame()
    expect(screenText()).toContain("second prompt")
    await app.cancelQueueItem("q1")
    app.frame()
    expect(backend.cancelled).toEqual(["q1"])
    expect(screenText()).not.toContain("second prompt")
    expect(screenText()).toContain("Queue is empty.")
    await app.stop()
  })

  it("a running row renders without [cancel]; queued rows carry it (capability present)", async () => {
    const backend = queueBackend([
      { id: "q1", text: "first prompt", delivery: "queue", intent: "user", state: "running", order: 1 },
      { id: "q2", text: "second prompt", delivery: "queue", intent: "user", state: "queued", order: 2 },
    ])
    const app = new TuiApp(testOptions({ backend }))
    await app.openQueue()
    app.frame()
    expect(screenText()).toContain("first prompt")
    expect(screenText()).toContain("second prompt")
    expect(screenText()).toContain("[cancel]")
    await app.stop()
  })

  it("backend without the queue capability: honest unavailable state, no fabricated empty", async () => {
    const app = new TuiApp(testOptions({ backend: noQueueBackend() }))
    await app.openQueue()
    app.frame()
    expect(screenText()).toContain("Queue status unavailable")
    expect(screenText()).not.toContain("Queue is empty.")
    await app.stop()
  })

  it("a refused cancel keeps whatever the backend truth lists after refresh", async () => {
    const backend = queueBackend([
      { id: "q1", text: "still queued", delivery: "queue", intent: "user", state: "queued", order: 1 },
    ])
    backend.cancelQueued = async () => ({ cancelled: false })
    const app = new TuiApp(testOptions({ backend }))
    await app.openQueue()
    app.frame()
    expect(screenText()).toContain("still queued")
    await app.cancelQueueItem("q1")
    app.frame()
    expect(backend.cancelled).toEqual([])
    expect(screenText()).toContain("still queued") // backend truth: the row is still there
    await app.stop()
  })
})
