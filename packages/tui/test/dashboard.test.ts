// M49 Task 13 — the local dashboard state + view over a REAL app (fixtures per
// the plan's Test Fixture Contract): row() = a literal DashboardSessionRow with
// only the fields the test names; dashboardApp() = a real TuiApp with an
// injected dashboard backend + real renderer/engine/palette/glyphs/write sink
// (no mocked presenter); waitFor pattern from Tasks 11/12. The backend rows are
// backend truth — never a fabricated projection.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { InputEvent, Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import type { InputSource } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import { createDashboardState } from "../src/views/dashboard-state.ts"
import { createCommandStatusSource, type StatusRunner } from "../src/app/status-source.ts"
import type { BackendClient, DashboardSessionRow } from "../src/contracts.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Queue-backed input source — the loop's real key path (char events). */
function keyInput(): { source: InputSource; pushChar(key: string): void; end(): void } {
  const queue: InputEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  return {
    source: {
      async *next(): AsyncIterable<InputEvent> {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!
          if (ended) return
          await new Promise<void>((resolve) => { wake = resolve })
        }
      },
    },
    pushChar(key) {
      queue.push({ type: "key", code: "char", key, ctrl: false, alt: false, shift: false })
      wake?.()
      wake = undefined
    },
    end() {
      ended = true
      wake?.()
      wake = undefined
    },
  }
}

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

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - t0 >= timeoutMs) throw new Error("waitFor: condition not met within budget")
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** Literal DashboardSessionRow — updatedAt: 1, live: false, only named fields. */
function row(id: string, title: string, extra: Partial<DashboardSessionRow> = {}): DashboardSessionRow {
  return { id, title, updatedAt: 1, live: false, ...extra }
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

/** Dashboard backend for the UI tests: real in-memory rows + recording open. */
function dashboardBackend(
  rows: DashboardSessionRow[],
  statusBits: { running: boolean; queued: number } = { running: false, queued: 0 },
): BackendClient & {
  readonly opened: string[]
  setRows(next: DashboardSessionRow[]): void
  setStatusBits(next: { running: boolean; queued: number }): void
  rows0(): DashboardSessionRow[]
} {
  const opened: string[] = []
  let items = rows.map((r) => ({ ...r }))
  let bits = { ...statusBits }
  return {
    opened,
    setRows(next) { items = next.map((r) => ({ ...r })) },
    setStatusBits(next) { bits = { ...next } },
    rows0() { return items.map((r) => ({ ...r })) },
    listSessions: async () => items.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt })),
    open: async (id) => { opened.push(id) },
    modelState: async () => ({ status: "unconfigured", reason: "No model configured" }),
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    events: async function* () { /* never ends — the app closes instead */ },
    seqCursor: () => 0,
    replay: async () => [],
    status: () => ({ ...bits }),
    close: async () => {},
    async dashboard() {
      return items.map((r) => ({ ...r }))
    },
  }
}

/** Backend with NO dashboard capability (an honest degrading host). */
function noDashboardBackend(): BackendClient {
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

// ------------------------------------------------------------------ state (Step 1)

describe("dashboard state (Task 13 step 1)", () => {
  it("keeps stable selection by session id while rows refresh", () => {
    const state = createDashboardState([
      row("s1", "One"), row("s2", "Two"),
    ])
    state.select("s2")
    state.replaceRows([row("s2", "Two updated"), row("s3", "Three")])
    expect(state.selectedId()).toBe("s2")
  })

  it("filters, pins, and orders only authoritative rows", () => {
    const state = createDashboardState([row("s1", "Alpha"), row("s2", "Beta")], {
      pinned: ["s2", "missing"], order: ["s1", "s2"],
    })
    state.setFilter("beta")
    expect(state.visibleRows().map((item) => item.id)).toEqual(["s2"])
  })

  it("keeps missing persisted ids without deleting them (deleted only after a successful commit)", () => {
    const state = createDashboardState([row("s1", "Alpha"), row("s2", "Beta")], {
      pinned: ["s2", "missing"], order: ["s1", "s2", "missing"],
    })
    // Missing ids never appear in the visible rows…
    expect(state.visibleRows().map((item) => item.id)).toEqual(["s2", "s1"])
    // …but they are still part of the persisted snapshot (ignored, not deleted).
    expect(state.persistedDashboard()).toEqual({ pinned: ["s2", "missing"], order: ["s1", "s2", "missing"] })
    // The successful-commit prune drops the ids that are no longer authoritative.
    state.pruneMissing([row("s1", "Alpha"), row("s2", "Beta")])
    expect(state.persistedDashboard()).toEqual({ pinned: ["s2"], order: ["s1", "s2"] })
  })

  it("pin/order stays under tui.prefs.dashboard ids: pin appends, unpin removes", () => {
    const state = createDashboardState([row("s1", "Alpha"), row("s2", "Beta"), row("s3", "Gamma")])
    state.pin("s2")
    expect(state.isPinned("s2")).toBe(true)
    expect(state.visibleRows().map((item) => item.id)).toEqual(["s2", "s1", "s3"])
    state.unpin("s2")
    expect(state.isPinned("s2")).toBe(false)
    expect(state.persistedDashboard().pinned).toEqual([])
  })
})

// ------------------------------------------------------------------ app (Step 3)

describe("dashboard over the real app (Task 13)", () => {
  it("renders backend rows and filters them; selection survives a refresh", async () => {
    const backend = dashboardBackend([row("s1", "Alpha"), row("s2", "Beta", { live: true, running: true, queued: 2, tasks: 1, modelLabel: "mock:mock-story" })])
    const app = new TuiApp(testOptions({ backend }))
    await app.openDashboard()
    // frame-per-poll: the public buffer holds the PRE-commit frame (M36
    // Footgun A), so a poll must outrun the microtask frames by one commit.
    await waitFor(() => {
      app.frame()
      return screenText().includes("Beta")
    })
    expect(screenText()).toContain("Alpha")
    expect(screenText()).toContain("Beta")
    expect(screenText()).toContain("mock:mock-story")
    // filter → only the matching row remains
    app.dashboard.select("s2")
    app.dashboard.setFilter("alpha")
    await waitFor(() => {
      app.frame()
      return screenText().includes("Alpha") && !screenText().includes("Beta")
    })
    // refresh from backend truth keeps the selected id stable
    backend.setRows([row("s2", "Beta updated"), row("s3", "Three")])
    await app.refreshDashboard()
    await waitFor(() => {
      app.frame()
      return !screenText().includes("Alpha") && !screenText().includes("Beta")
    })
    expect(app.dashboard.selectedId()).toBe("s2")
    await app.stop()
  })

  it("types the filter through the REAL key path (the prompt never swallows charset on the dashboard)", async () => {
    // Regression: the dashboard screen keeps app.focused "prompt" — the
    // loop's prompt-edit branch used to swallow the typed chars (they landed
    // in the invisible prompt; the filter never changed).
    const backend = dashboardBackend([row("s1", "Alpha"), row("s2", "Beta")])
    const input = keyInput()
    const app = new TuiApp({ ...testOptions({ backend }), input: input.source })
    await app.initialize()
    void app.start()
    try {
      await app.openDashboard()
      await waitFor(() => app.dashboard.visibleRows().length === 2)
      app.frame()
      for (const k of "bet") input.pushChar(k)
      await waitFor(() => {
        app.frame()
        return app.dashboard.filter() === "bet"
      }, 5_000)
      expect(app.dashboard.visibleRows().map((item) => item.id)).toEqual(["s2"])
      // the prompt never received the letters (no prompt box on this surface)
      expect(app.state().prompt.text).toBe("")
    } finally {
      input.end()
      await app.stop()
    }
  }, 60_000)

  it("opens a dashboard row and preserves state when returning", async () => {
    const app = dashboardApp([row("s1", "One"), row("s2", "Two")])
    await waitFor(() => app.dashboard.visibleRows().length === 2)
    app.dashboard.select("s2")
    await app.openSelectedDashboardSession()
    expect(app.state().screen).toBe("agent")
    expect(app.state().view).toEqual({ kind: "agent", sessionId: "s2" })
    await app.goHome()
    expect(app.dashboard.selectedId()).toBe("s2")
    expect(app.state().screen).toBe("welcome")
    await app.stop()
  })

  it("the builtin status row renders the REAL queued count (+N) and clears it when it drains", async () => {
    const backend = dashboardBackend([row("s1", "Alpha", { live: true, running: true })], { running: true, queued: 2 })
    const app = new TuiApp({ ...testOptions({ backend }), statusLine: { mode: "builtin" } })
    try {
      // the open path recomputes the builtin row from backend truth.
      await app.openDashboard()
      await waitFor(() => {
        app.frame()
        return screenText().includes("+2")
      })
      // drain the queue → the chip must clear (a stale +2 is a fabricated lie);
      // the builtin row recomputes at the app's refresh boundaries — drive one
      // through the same public dashboard-open path again.
      backend.setStatusBits({ running: true, queued: 0 })
      await app.openDashboard()
      await waitFor(() => {
        app.frame()
        return !screenText().includes("+2")
      })
    } finally {
      await app.stop()
    }
  })

  it("backend without the dashboard capability: honest unavailable state", async () => {
    const app = new TuiApp(testOptions({ backend: noDashboardBackend() }))
    await app.openDashboard()
    await waitFor(() => {
      app.frame()
      return screenText().includes("Dashboard unavailable")
    })
    expect(screenText()).toContain("Dashboard unavailable")
    expect(screenText()).not.toContain("Alpha")
    await app.stop()
  })

  it("a FAILED dashboard fetch keeps the previous rows and says so (never 'no sessions' for an error)", async () => {
    let failures = 0
    const backend = dashboardBackend([row("s1", "Alpha")])
    const failing: BackendClient = {
      ...backend,
      async dashboard() {
        const call = failures
        failures++
        if (call === 0) return backend.rows0()
        throw new Error(`backend down (call ${call})`)
      },
    }
    const app = new TuiApp(testOptions({ backend: failing }))
    try {
      await app.openDashboard()
      await waitFor(() => {
        app.frame()
        return screenText().includes("Alpha")
      })
      await app.refreshDashboard()
      await waitFor(() => {
        app.frame()
        return screenText().includes("refresh failed")
      })
      expect(screenText()).toContain("Alpha") // stale rows stay — never wiped
      expect(screenText()).not.toContain("No local sessions yet")
      expect(screenText()).not.toContain("Dashboard unavailable")
    } finally {
      await app.stop()
    }
  })

  it("the command status line refreshes no faster than 300ms (real anim pump, real clock)", async () => {
    const times: number[] = []
    const runner: StatusRunner = async () => {
      times.push(Date.now())
      return `v${times.length}`
    }
    const backend = dashboardBackend([])
    const opts = testOptions({ backend })
    opts.now = () => Date.now()
    const app = new TuiApp({
      ...opts,
      statusLine: {
        mode: "command",
        commandSource: createCommandStatusSource(runner, { timeoutMs: 1000, refreshMs: 300 }),
        commandRefreshMs: 300,
      },
    })
    void app.start()
    try {
      await sleep(1_450) // many 33ms pump ticks — every refresh ≥300ms apart
      expect(times.length).toBeGreaterThanOrEqual(3)
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(290)
      }
    } finally {
      await app.stop()
    }
  }, 20_000)
})

/** Real TuiApp fixture (fixture contract: dashboardApp) — the production bare
 * launch flow: initialize (→ Welcome with an unconfigured model) then open the
 * dashboard from the Welcome surface. */
function dashboardApp(rows: DashboardSessionRow[]): TuiApp {
  const backend = dashboardBackend(rows)
  const app = new TuiApp(testOptions({ backend }))
  void (async () => {
    await app.initialize()
    await app.openDashboard()
  })()
  return app
}
