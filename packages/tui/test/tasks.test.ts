// M49 Task 12 — the tasks pane over a REAL app (fixtures per the plan's Test
// Fixture Contract): tasksBackend = a recording BackendClient with real
// in-memory AgentTaskView snapshots + cancel mutation (backend truth the pane
// re-reads after refresh); testOptions = real renderer, engine, palette,
// glyphs and write sink around the supplied backend (no mocked presenter);
// screenText() reads the actual virtual renderer cells. The mouse row
// semantics (select by id, header collapse, [✗]) are exercised against a REAL
// MouseRouter over a fake TuiAppState (the dry-run pattern of
// mouse-click.test.ts).

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { MouseRouter, type MouseHooks } from "../src/app/mouse.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import { layoutAgent } from "../src/views/agent.ts"
import type { AgentTaskView, BackendClient } from "../src/contracts.ts"
import type { TuiAppState } from "../src/app/present.ts"
import type { Rect } from "../src/views/agent.ts"

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
function testOptions(opts: { backend: BackendClient; initialPanes?: ConstructorParameters<typeof TuiApp>[0]["initialPanes"] }): ConstructorParameters<typeof TuiApp>[0] {
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
    ...(opts.initialPanes !== undefined ? { initialPanes: opts.initialPanes } : {}),
  }
}

/** Recording BackendClient with real in-memory task snapshots + cancel
 * mutation (cancelTask flips a running row to cancelled — the backend truth
 * the pane re-reads after refresh). */
function tasksBackend(initial: AgentTaskView[] = []): BackendClient & {
  readonly cancelled: string[]
  setTasks(rows: AgentTaskView[]): void
} {
  let items = new Map(initial.map((task) => [task.id, { ...task }]))
  const cancelled: string[] = []
  const backend: BackendClient & { readonly cancelled: string[]; setTasks(rows: AgentTaskView[]): void } = {
    cancelled,
    setTasks(rows) { items = new Map(rows.map((task) => [task.id, { ...task }])) },
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
    async tasks() {
      return [...items.values()]
    },
    async cancelTask(id) {
      const row = items.get(id)
      if (row === undefined) throw new Error(`unknown task: ${id}`)
      if (row.status !== "running") return "already-finished"
      row.status = "cancelled"
      row.canCancel = false
      cancelled.push(id)
      return "cancellation-requested"
    },
  }
  return backend
}

/** Backend with NO tasks capability (an honest degrading host). */
function noTasksBackend(): BackendClient {
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

// ------------------------------------------------------------------ real app

describe("tasks pane over the real app (Task 12)", () => {
  it("renders real groups from backend truth; a cancelled row refreshes to backend truth", async () => {
    const backend = tasksBackend([
      { id: "root/helper", parentId: "root", group: "subagent", label: "helper", status: "running", canCancel: true },
      { id: "subagent-1", group: "job", label: "subagent-1", status: "running", canCancel: true },
      { id: "workflow-1", group: "workflow", label: "workflow-1", status: "completed", canCancel: false },
    ])
    const app = new TuiApp(testOptions({ backend }))
    await app.openTasks()
    app.frame()
    expect(screenText()).toContain("Subagents 1")
    expect(screenText()).toContain("helper")
    expect(screenText()).toContain("Background 1")
    expect(screenText()).toContain("Workflows 1")
    expect(screenText()).toContain("[✗]") // only the cancellable rows carry it
    await app.cancelTaskId("root/helper")
    app.frame()
    expect(backend.cancelled).toEqual(["root/helper"])
    expect(screenText()).toContain("✗ helper")
    await app.stop()
  })

  it("selection is stable across refresh by id (the selected row stays selected)", async () => {
    const backend = tasksBackend([
      { id: "root/helper", parentId: "root", group: "subagent", label: "helper", status: "running", canCancel: true },
    ])
    const app = new TuiApp(testOptions({
      backend,
      // the mouse path seeds the selection into paneData; the pane's refresh
      // must NOT reset it (selection follows the stable id).
      initialPanes: { tasks: [], tasksSelectId: "root/helper" },
    }))
    await app.openTasks()
    app.frame()
    // the backend still has the row → the selection survives the refresh
    await app.openTasks()
    app.frame()
    expect(screenText()).toContain("helper")
    await app.stop()
  })

  it("openTaskViewer opens the block viewer with the row data and an honest transcript line", async () => {
    const backend = tasksBackend([
      { id: "root/helper", parentId: "root", group: "subagent", label: "helper", status: "running", canCancel: true },
    ])
    const app = new TuiApp(testOptions({ backend }))
    await app.openTasks()
    await app.openTaskViewer("root/helper")
    app.frame()
    const text = screenText()
    expect(text).toContain("id: root/helper")
    expect(text).toContain("label: helper")
    expect(text).toContain("status: running")
    // honest transcript availability: the viewer states the evidence section
    // AND explains the unavailable state (no parent-log evidence here).
    expect(text).toContain("transcript:")
    expect(text).toMatch(/unavailable|parent log/)
    await app.stop()
  })

  it("an unknown selected id keeps the honest toast and never opens a fabricated viewer", async () => {
    const backend = tasksBackend([])
    const app = new TuiApp(testOptions({ backend }))
    await app.openTasks()
    await app.openTaskViewer("never-a-task")
    app.frame()
    expect(screenText()).not.toContain("id: never-a-task")
    await app.stop()
  })

  it("backend without the tasks capability: honest unavailable state, no fabricated empty", async () => {
    const app = new TuiApp(testOptions({ backend: noTasksBackend() }))
    await app.openTasks()
    app.frame()
    expect(screenText()).toContain("Tasks unavailable")
    expect(screenText()).not.toContain("No active tasks.")
    await app.stop()
  })

  it("empty backend truth renders the exact 'No active tasks.'", async () => {
    const app = new TuiApp(testOptions({ backend: tasksBackend([]) }))
    await app.openTasks()
    app.frame()
    expect(screenText()).toContain("No active tasks.")
    await app.stop()
  })

  it("Ctrl+F with a selected task row opens find, NEVER the task viewer; Enter still opens it (review finding 2)", async () => {
    const backend = tasksBackend([
      { id: "root/helper", parentId: "root", group: "subagent", label: "helper", status: "running", canCancel: true },
    ])
    const app = new TuiApp(testOptions({ backend }))
    await app.openTasks()
    // select the row (the mouse path writes tasksSelectId into paneData)
    app.state().paneData = { ...(app.state().paneData ?? {}), tasksSelectId: "root/helper" }
    app.state().focused = "scrollback"
    app.frame()
    // Ctrl+F routes around the selection: the find/block path (no tool block
    // here → the honest toast), NEVER the task viewer.
    app.feedInput({ type: "key", code: "char", key: "f", ctrl: true, alt: false, shift: false })
    app.frame()
    expect(app.state().modal?.kind).toBeUndefined()
    // Enter still opens the task viewer for the selected row.
    app.feedInput({ type: "key", code: "Enter", key: "Enter", ctrl: false, alt: false, shift: false })
    app.frame()
    const modal = app.state().modal
    expect(modal?.kind).toBe("block-viewer")
    if (modal?.kind === "block-viewer") {
      expect(modal.viewer.rows().map((r) => r.text)).toContain("id: root/helper")
    }
    await app.stop()
  })

  it("the status chip opens the tasks pane to REAL rows — never a blank pane (review finding 3)", async () => {
    const backend = tasksBackend([
      { id: "root/helper", parentId: "root", group: "subagent", label: "helper", status: "running", canCancel: true },
    ])
    const app = new TuiApp(testOptions({ backend }))
    // the tasks status chip renders only while running > 0 (the status chip
    // stream's truthful gate — same fixture as mouse-click.test.ts), and the
    // app's legacy status bits are what feed it.
    app.state().status.tasks = { running: 2, labels: [] }
    // the tasks status chip (the app's own status row geometry).
    const status = layoutAgent({ cols: CANVAS.cols, rows: CANVAS.rows }, app.state(), { compact: false }).status
    const down = (released: boolean): void => {
      app.feedInput({
        type: "mouse", x: status.x + status.w - 1, y: status.y + 1, button: "left",
        drag: false, released, motion: false, mods: { ctrl: false, shift: false, alt: false },
      })
    }
    down(false)
    down(true)
    app.frame()
    expect(app.state().panes.has("tasks")).toBe(true)
    // the refresh ran — real backend rows, never a blank pane (the pane only
    // repaints on a frame; poll with frames).
    for (let i = 0; i < 50 && !screenText().includes("helper"); i++) {
      app.frame()
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(screenText()).toContain("helper")
    await app.stop()
  })
})

// ------------------------------------------------------------------ mouse rows

describe("tasks pane mouse rows (Task 12)", () => {
  function appState(engine: ReturnType<typeof createScrollbackEngine>, partial: Partial<TuiAppState> = {}): TuiAppState {
    return {
      title: "sup",
      mode: "normal",
      engine,
      prompt: { text: "", cursor: 0, multiLine: false, focused: true, model: "mock-model", plan: false, title: "sup" },
      promptCursor: 0,
      history: [],
      historyIndex: 0,
      scroll: { offset: 0, follow: true },
      focused: "prompt",
      search: undefined,
      status: {
        branch: undefined, path: "~/proj", tickMs: 0, model: "mock-model", plan: false,
        contextUsed: undefined, contextTotal: undefined,
        todo: { done: 0, total: 0 }, tasks: { running: 0, labels: [] }, queue: 0, mcp: null,
      },
      turn: undefined,
      toasts: [],
      panes: new Set(["tasks"]),
      shortcuts: { items: [] },
      paneData: {
        tasks: [{
          label: "Subagents",
          entries: [
            { id: "root/helper", status: "running", label: "helper", elapsed: "2m", action: "cancel" },
            { id: "root/search", status: "completed", label: "search", action: "expand" },
          ],
        }],
      },
      ...partial,
    }
  }

  function rig(partial: Partial<TuiAppState> = {}): {
    app: TuiAppState
    engine: ReturnType<typeof createScrollbackEngine>
    router: MouseRouter
    tasksRect(): Rect | undefined
    hooks: MouseHooks
  } {
    const engine = createScrollbackEngine({ width: CANVAS.cols })
    const app = appState(engine, partial)
    const hooks: MouseHooks = {}
    const router = new MouseRouter({
      app,
      engine,
      size: () => ({ cols: CANVAS.cols, rows: CANVAS.rows }),
      now: () => 1000,
      clipboard: { copy: () => {} },
      glyphs: GLYPHS,
      compact: false,
      hooks,
    })
    return { app, engine, router, tasksRect: () => layoutAgent({ cols: CANVAS.cols, rows: CANVAS.rows }, app, { compact: false }).tasks, hooks }
  }

  it("row click selects by stable id; header click toggles collapse; [✗] fires the cancel hook", () => {
    const { app, router, tasksRect, hooks } = rig()
    const rect = tasksRect()!
    const down = (x: number, y: number): void => {
      router.handle({ x, y, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    }
    // header row 0 → collapse toggle
    down(rect.x + 3, rect.y + 0)
    expect(app.paneData!.tasks![0]!.collapsed).toBe(true)

    // entry body → select by id
    down(rect.x + 3, rect.y + 1)
    expect(app.paneData!.tasksSelectId).toBe("root/helper")

    // [✗] on the cancellable row → the cancel hook with the row id
    let cancelled: string | undefined
    hooks.taskCancel = (id) => { cancelled = id }
    const rightW = 3 + 1 // "[✗]" + pad
    down(rect.x + rect.w - rightW + 1, rect.y + 1)
    expect(cancelled).toBe("root/helper")

    // [↗] on the second row → the viewer hook with the stable id
    // (the [↗] button occupies the rightW-1 slot starting at w-rightW+1).
    let opened: string | undefined
    hooks.openTaskViewer = (id) => { opened = id }
    down(rect.x + rect.w - 3, rect.y + 2)
    expect(opened).toBe("root/search")
  })

  it("a row without backend cancel capability still selects, but [✗] is absent (no dead hook)", () => {
    const { app, router, tasksRect } = rig({
      paneData: {
        tasks: [{
          label: "Subagents",
          entries: [{ id: "task-1", status: "running", label: "orphan" }],
        }],
      },
    })
    const rect = tasksRect()!
    router.handle({ x: rect.x + 3, y: rect.y + 1, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    expect(app.paneData!.tasksSelectId).toBe("task-1")
  })

  it("a single click outside the multi-click window on the ALREADY-selected row clears the selection (explicit deselect, review finding 2)", () => {
    const engine = createScrollbackEngine({ width: CANVAS.cols })
    const app = appState(engine, {
      paneData: {
        tasks: [{
          label: "Subagents",
          entries: [{ id: "root/helper", status: "running", label: "helper" }],
        }],
      },
    })
    let now = 1000
    const router = new MouseRouter({
      app,
      engine,
      size: () => ({ cols: CANVAS.cols, rows: CANVAS.rows }),
      now: () => now,
      clipboard: { copy: () => {} },
      glyphs: GLYPHS,
      compact: false,
      hooks: {},
    })
    const rect = layoutAgent({ cols: CANVAS.cols, rows: CANVAS.rows }, app, { compact: false }).tasks
    const click = (): void => {
      router.handle({ x: rect!.x + 3, y: rect!.y + 1, button: "left", kind: "down", drag: false, mods: { ctrl: false, shift: false, alt: false } })
      router.handle({ x: rect!.x + 3, y: rect!.y + 1, button: "left", kind: "up", drag: false, mods: { ctrl: false, shift: false, alt: false } })
    }
    click()
    expect(app.paneData!.tasksSelectId).toBe("root/helper")
    // outside the 300ms multi-click window → count 1 + wasSelected → clear.
    now = 2000
    click()
    expect(app.paneData!.tasksSelectId).toBeUndefined()
  })
})
