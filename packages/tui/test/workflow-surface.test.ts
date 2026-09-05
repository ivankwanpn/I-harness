// M46c G2: the /workflow surface — `run <name> | status [id] | list` against a
// FAKE WorkflowSurface (contracts.ts) — panel row rendering (name/status +
// running `[stop]`), the run flow via the text-input seam, the honest
// "(M46d)" toast when cancel is absent, and the [r] refresh closure. Plus a
// small REAL-surface smoke test (the @i-harness/workflow registry scan + a
// local exec run through the package's runner).

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/index.ts"
import type { BackendClient, TuiEvent } from "../src/contracts.ts"
import { CommandRegistry } from "../src/app/slash/registry.ts"
import { createDefaultWorkflowSurface, jobStatusRow, workflowParams } from "../src/app/slash/impl/workflow2.ts"
import type { SlashContext, SlashPanelRequest } from "../src/app/slash/types.ts"
import type { WorkflowListEntry, WorkflowRunOutput } from "@i-harness/workflow"
import type { WorkflowJobView, WorkflowSurface } from "../src/contracts.ts"

// ------------------------------------------------------------------ the fake surface

function fakeSurface(opts: { cancel?: boolean } = {}): WorkflowSurface & {
  calls: string[]
  jobs: ReturnType<typeof views>
} {
  const calls: string[] = []
  const jobs = views([{ id: "workflow-1", status: "running" }])
  const defs: WorkflowListEntry[] = [
    { name: "build", description: "Build it", steps: 3, params: {} },
    { name: "test", description: "Test it", steps: 2, params: { input: { description: "what" } } },
  ]
  const surf: WorkflowSurface = {
    async list() { calls.push("list"); return defs },
    async run(name, params) {
      calls.push(`run:${name}:${JSON.stringify(params)}`)
      const out: WorkflowRunOutput = { run_id: "workflow-2", job_id: "workflow-2", status: "running" }
      jobs.push({ id: "workflow-2", status: "running" })
      return out
    },
    async status(id) {
      calls.push(`status:${id ?? ""}`)
      return id === undefined ? jobs.items : jobs.items.filter((j) => j.id === id)
    },
    ...(opts.cancel === false
      ? {}
      : { async cancel(id: string) { calls.push(`cancel:${id}`); return "cancellation-requested" as const } }),
  }
  return Object.assign(surf, { calls, jobs })
}

type JobInit = { id: string; status: "running" | "completed" | "killed" | "error"; exitCode?: number }

function toView(j: JobInit): WorkflowJobView {
  return { id: j.id, status: j.status, stdout: "", stderr: "", ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}) }
}

function views(initial: JobInit[]) {
  const items: WorkflowJobView[] = initial.map(toView)
  return { items, push: (j: JobInit) => items.push(toView(j)) }
}

/** A minimal fake ctx — panels/input-requests/toasts recorded. */
function fakeCtx(surface: WorkflowSurface): SlashContext & {
  calls: string[]
  panels: SlashPanelRequest[]
  inputRequests: Array<{ title: string; onSubmit(text: string): void; onCancel?(): void }>
} {
  const calls: string[] = []
  const panels: SlashPanelRequest[] = []
  const inputRequests: Array<{ title: string; onSubmit(text: string): void; onCancel?(): void }> = []
  const ctx = {
    app: {},
    backend: {},
    engine: {},
    input: "",
    arg: "",
    toast: (t: string) => calls.push(`toast:${t}`),
    openPanel: (req: SlashPanelRequest) => { panels.push(req); calls.push(`panel:${req.kind}`) },
    workflow: surface,
    openTextInput: (o: { title: string; onSubmit(text: string): void; onCancel?(): void }) => { inputRequests.push(o); calls.push(`input:${o.title}`) },
  } as unknown as SlashContext & { calls: string[]; panels: SlashPanelRequest[]; inputRequests: typeof inputRequests }
  return Object.assign(ctx, { calls, panels, inputRequests })
}

const registry = new CommandRegistry()
const run = async (line: string, ctx: SlashContext): Promise<void> => {
  const m = registry.matches(line, ctx)
  if (m === undefined) throw new Error(`no match for ${line}`)
  const c = ctx as SlashContext & { arg: string; input: string }
  c.arg = m.arg
  c.input = line
  await m.command.run(ctx)
}

// ------------------------------------------------------------------ tests

describe("/workflow (fake surface)", () => {
  it("list: registry rows (name + step count)", async () => {
    const surf = fakeSurface()
    const ctx = fakeCtx(surf)
    await run("/workflow list", ctx)
    expect(ctx.panels[0]?.title).toBe("Workflows")
    expect(ctx.panels[0]?.rows).toEqual([
      { label: "build", detail: "3 steps" },
      { label: "test", detail: "2 steps" },
    ])
    expect(surf.calls).toContain("list")
  })

  it("bare /workflow = the register index; unknown subcommand toasts the usage", async () => {
    const ctx = fakeCtx(fakeSurface())
    await run("/workflow", ctx)
    expect(ctx.panels[0]?.title).toBe("Workflows")
    const ctx2 = fakeCtx(fakeSurface())
    await run("/workflow frobnicate", ctx2)
    expect(ctx2.calls.some((c) => c.startsWith("toast:workflow: unknown subcommand"))).toBe(true)
  })

  it("status: job rows with status; running rows carry [stop]; Enter → cancel", async () => {
    const surf = fakeSurface()
    const ctx = fakeCtx(surf)
    await run("/workflow status", ctx)
    const panel = ctx.panels[0]!
    expect(panel.title).toBe("Workflow status")
    expect(panel.rows).toEqual([{ label: "workflow-1", detail: "running [stop]" }])
    expect(panel.refresh).toBeDefined()
    expect(surf.calls).toContain("status:")
    panel.onSelect?.(0)
    // the cancel resolves async — flush the microtasks.
    await new Promise((r) => setTimeout(r, 0))
    expect(surf.calls).toContain("cancel:workflow-1")
    expect(ctx.calls.some((c) => c.includes("stop requested"))).toBe(true)
  })

  it("status <id> filters to that job; completed rows show the exit code", async () => {
    const surf = fakeSurface()
    surf.jobs.push({ id: "workflow-9", status: "completed", exitCode: 0 })
    const ctx = fakeCtx(surf)
    await run("/workflow status workflow-9", ctx)
    expect(surf.calls).toContain("status:workflow-9")
    expect(ctx.panels[0]?.title).toBe("Workflow status · workflow-9")
    expect(ctx.panels[0]?.rows[0]).toEqual({ label: "workflow-9", detail: "completed(exit=0)" })
  })

  it("jobStatusRow: running → `running [stop]`; error/killed rows have no [stop]", () => {
    expect(jobStatusRow({ id: "w1", status: "running", stdout: "", stderr: "" })).toEqual({ label: "w1", detail: "running [stop]" })
    expect(jobStatusRow({ id: "w2", status: "error", stdout: "", stderr: "", exitCode: 2 })).toEqual({ label: "w2", detail: "error(exit=2)" })
    expect(jobStatusRow({ id: "w3", status: "killed", stdout: "", stderr: "" })).toEqual({ label: "w3", detail: "killed" })
  })

  it("run flow: the text-input asks for the params line; submit starts the run + opens status", async () => {
    const surf = fakeSurface()
    const ctx = fakeCtx(surf)
    await run("/workflow run build", ctx)
    const req = ctx.inputRequests[0]!
    expect(req.title).toContain("build")
    req.onSubmit("in=hello out=42 plain")
    await new Promise((r) => setTimeout(r, 0)) // the async run + status fetch
    expect(surf.calls).toContain('run:build:{"in":"hello","out":"42"}')
    expect(ctx.calls.some((c) => c.includes("workflow run started: build (workflow-2)"))).toBe(true)
    // the status panel opened right after the run (all jobs, newest last).
    const last = ctx.panels[ctx.panels.length - 1]!
    expect(last.title).toBe("Workflow status")
    expect(last.rows).toEqual([
      { label: "workflow-1", detail: "running [stop]" },
      { label: "workflow-2", detail: "running [stop]" },
    ])
  })

  it("workflowParams: k=v whitespace tokens; non-`=` tokens are ignored", () => {
    expect(workflowParams("a=1 b=2")).toEqual({ a: "1", b: "2" })
    expect(workflowParams("in=hello world")).toEqual({ in: "hello" })
    expect(workflowParams("  key=value  ")).toEqual({ key: "value" })
    expect(workflowParams("plain")).toEqual({})
  })

  it("run: unknown workflow → early toast (no input prompt)", async () => {
    const ctx = fakeCtx(fakeSurface())
    await run("/workflow run nope", ctx)
    expect(ctx.calls.some((c) => c.includes('unknown workflow "nope"'))).toBe(true)
    expect(ctx.inputRequests).toHaveLength(0)
  })

  it("honest stop: surface without cancel → the (M46d) toast", async () => {
    const surf = fakeSurface({ cancel: false })
    const ctx = fakeCtx(surf)
    await run("/workflow status", ctx)
    ctx.panels[0]!.onSelect?.(0)
    expect(ctx.calls.some((c) => c.includes("M46d"))).toBe(true)
    expect(surf.calls).not.toContain("cancel:workflow-1")
  })

  it("refresh closure: [r] re-fetches and re-opens the panel (no-pump)", async () => {
    const surf = fakeSurface()
    const ctx = fakeCtx(surf)
    await run("/workflow status", ctx)
    const panelsBefore = ctx.panels.length
    const before = surf.calls.filter((c) => c.startsWith("status:")).length
    ctx.panels[0]!.refresh!()
    await Promise.resolve()
    expect(surf.calls.filter((c) => c.startsWith("status:")).length).toBe(before + 1)
    expect(ctx.panels.length).toBe(panelsBefore + 1)
  })
})

describe("/workflow [r] key (loop level)", () => {
  const cap: TerminalCapabilityContext = {
    ...createUnknownCapabilities(),
    colorLevel: "truecolor",
    dark: true,
    brand: "WindowsTerminal",
    multiplexer: "none",
  }
  const palette = resolvePalette(cap, "groknight")
  const r: Renderer = createRenderer({ cols: 100, rows: 24, cap })

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

  const keyEv = (key: string): InputEvent => ({ type: "key", code: "char", key, ctrl: false, alt: false, shift: false })

  it("[r] re-fetches ONLY while the workflow panel is open; other chars don't", () => {
    const app = new TuiApp({
      renderer: r,
      backend: stubBackend(),
      engine: createScrollbackEngine({ width: 100 }),
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: () => {},
      now: () => 0,
    })
    let refreshed = 0
    app.state().lightPanel = {
      kind: "workflow",
      title: "Workflow status",
      rows: [{ label: "workflow-1", detail: "running [stop]" }],
      cursor: 0,
      refresh: () => { refreshed++ },
    }
    app.feedInput(keyEv("r"))
    expect(refreshed).toBe(1)
    app.feedInput(keyEv("s")) // a non-r char edits the prompt, not the panel
    expect(refreshed).toBe(1)
    app.state().lightPanel = undefined
    app.feedInput(keyEv("r"))
    expect(refreshed).toBe(1) // panel closed → [r] is a plain prompt edit
  })
})

describe("/workflow (default REAL surface — @i-harness/workflow)", () => {
  let ws: string
  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "ih-wf-surface-"))
    mkdirSync(join(ws, "workflow"), { recursive: true })
    writeFileSync(
      join(ws, "workflow", "build.yml"),
      'name: build\ndescription: "Build it"\nsteps:\n  - name: hi\n    command: node -e "console.log(39)"\n',
    )
    writeFileSync(
      join(ws, "workflow", "slow.yml"),
      'name: slow\ndescription: "Slow one"\nsteps:\n  - name: pause\n    command: node -e "setTimeout(() => console.log(1), 5000)"\n',
    )
  })
  afterAll(() => {
    try { rmSync(ws, { recursive: true, force: true }) } catch { /* tmp */ }
  })

  it("list scans <workspace>/workflow/*.yml; status shows the finished job", async () => {
    const surf = createDefaultWorkflowSurface(ws)
    const defs = await surf.list()
    expect(defs.map((d) => ({ name: d.name, steps: d.steps }))).toEqual([
      { name: "build", steps: 1 },
      { name: "slow", steps: 1 },
    ])
    const out = await surf.run("build", {})
    expect(out.status).toBe("running")
    expect(out.job_id).toBe("workflow-1")
    // poll the runner (the run completes in-process within ms).
    let view = (await surf.status())[0]!
    for (let i = 0; view.status === "running" && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 20))
      view = (await surf.status())[0]!
    }
    expect(view.status).toBe("completed")
    expect(view.stdout).toContain("39")
  })

  it("cancel stops a running job through the executor kill", async () => {
    const surf = createDefaultWorkflowSurface(ws)
    const out = await surf.run("slow", {})
    expect(await surf.cancel!(out.job_id)).toBe("cancellation-requested")
    const view = (await surf.status(out.job_id))[0]!
    expect(view.status).toBe("killed")
  })
})
