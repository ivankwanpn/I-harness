// @i-harness/tui — G2 (M46c): the /workflow surface — `run <name> | status
// [id] | list`.
// The panel rows are @i-harness/workflow READ shapes (the same data the
// workflow_run / workflow_list tools expose: definitions via the registry,
// job status via the executor facade — listJobs/getOutput/killJob). The
// command itself NEVER imports the packages: it drives the injected
// WorkflowSurface (contracts.ts) — the loop wires the default real host
// (createDefaultWorkflowSurface below), tests inject a fake.

import { spawn } from "node:child_process"
import {
  createWorkflowExecutor,
  createWorkflowRegistry,
  type WorkflowDefinition,
  type WorkflowListEntry,
} from "@i-harness/workflow"
import type { WorkflowJobView, WorkflowSurface } from "../../../contracts.ts"
import type { SlashCommand, SlashContext } from "../types.ts"
import type { LightPanelRow } from "../../../views/light-panel.ts"
import { WORKFLOW_DEFS_EMPTY, WORKFLOW_JOBS_EMPTY } from "../../../views/light-workflow.ts"

// ------------------------------------------------------------------ row mappers

/** One job row: id + right-aligned status detail; RUNNING rows gain the
 * `[stop]` marker (Enter / click on the row → cancel or the honest toast). */
export function jobStatusRow(job: WorkflowJobView): LightPanelRow {
  if (job.status === "running") return { label: job.id, detail: "running [stop]" }
  const exit = job.exitCode !== undefined ? `(exit=${job.exitCode})` : ""
  return { label: job.id, detail: `${job.status}${exit}` }
}

/** Params line → params map: whitespace-separated `key=value` tokens (the
 * run input text-input line). Tokens without `=` are ignored (documented). */
export function workflowParams(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const tok of text.trim().split(/\s+/)) {
    if (tok === "") continue
    const eq = tok.indexOf("=")
    if (eq <= 0) continue
    out[tok.slice(0, eq)] = tok.slice(eq + 1)
  }
  return out
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ------------------------------------------------------------------ the panel flows

async function openListPanel(ctx: SlashContext, surf: WorkflowSurface): Promise<void> {
  let defs: WorkflowListEntry[]
  try {
    defs = await surf.list()
  } catch (error) {
    ctx.toast(`workflow list failed: ${msg(error)}`)
    return
  }
  const rows: LightPanelRow[] = defs.length === 0
    ? [{ label: WORKFLOW_DEFS_EMPTY.trim() }]
    : defs.map((d) => ({ label: d.name, detail: `${d.steps} steps` }))
  ctx.openPanel({ kind: "workflow", title: "Workflows", rows })
}

async function openStatusPanel(ctx: SlashContext, surf: WorkflowSurface, id: string | undefined): Promise<void> {
  let jobs: WorkflowJobView[]
  try {
    jobs = await surf.status(id)
  } catch (error) {
    ctx.toast(`workflow status failed: ${msg(error)}`)
    return
  }
  const rows: LightPanelRow[] = jobs.length === 0
    ? [{ label: WORKFLOW_JOBS_EMPTY.trim() }]
    : jobs.map((j) => jobStatusRow(j))
  ctx.openPanel({
    kind: "workflow",
    title: id === undefined ? "Workflow status" : `Workflow status · ${id}`,
    rows,
    // [r] refresh (no-pump: refresh on open + this key — the loop's key
    // intercept re-opens the panel with fresh rows).
    refresh: () => void openStatusPanel(ctx, surf, id),
    onSelect: (index) => onJobSelect(ctx, surf, jobs[index]),
  })
}

function onJobSelect(ctx: SlashContext, surf: WorkflowSurface, job: WorkflowJobView | undefined): void {
  if (job === undefined) return
  if (job.status !== "running") {
    ctx.toast(`workflow: ${job.id} is ${job.status}`)
    return
  }
  // Honest stop: no cancel on the surface → the "(M46d)" toast (the default
  // @i-harness/workflow host HAS killJob — this path is for hosts without it).
  if (surf.cancel === undefined) {
    ctx.toast("workflow stop (M46d): cancel not wired")
    return
  }
  void surf.cancel(job.id).then(
    (r) => ctx.toast(r === "cancellation-requested"
      ? `workflow: ${job.id} stop requested`
      : `workflow: ${job.id} already finished`),
    (error) => ctx.toast(`workflow stop failed: ${msg(error)}`),
  )
}

function requestWorkflowRun(ctx: SlashContext, surf: WorkflowSurface, name: string): void {
  const open = ctx.openTextInput
  if (open === undefined) {
    ctx.toast("workflow run: input seam not wired")
    return
  }
  open({
    title: `workflow run · ${name}`,
    onSubmit: (text) => {
      const params = workflowParams(text)
      void surf.run(name, params).then(
        (out) => {
          ctx.toast(`workflow run started: ${name} (${out.job_id})`)
          void openStatusPanel(ctx, surf, undefined)
        },
        (error) => ctx.toast(`workflow run failed: ${msg(error)}`),
      )
    },
    onCancel: () => ctx.toast("workflow run cancelled"),
  })
}

// ------------------------------------------------------------------ the command

export const workflowCommands: SlashCommand[] = [
  {
    name: "workflow",
    description: "Run/list workflow jobs (run <name> | status [id] | list)",
    argumentHint: "run <name> | status [id] | list",
    run: async (ctx) => {
      const surf = ctx.workflow
      if (surf === undefined) {
        ctx.toast("workflow: surface not wired")
        return
      }
      const [head, ...rest] = ctx.arg.split(/\s+/)
      if (head === "run") {
        const name = rest[0]
        if (name === undefined || name === "") {
          ctx.toast("workflow run: <name> required — /workflow list")
          return
        }
        // Verify the name against the registry BEFORE asking for the params
        // line (an unknown name fails loudly, not silently mid-flow).
        try {
          const defs = await surf.list()
          if (!defs.some((d) => d.name === name)) {
            ctx.toast(`workflow run: unknown workflow "${name}"`)
            return
          }
        } catch (error) {
          ctx.toast(`workflow run: ${msg(error)}`)
          return
        }
        requestWorkflowRun(ctx, surf, name)
        return
      }
      if (head === "status") {
        await openStatusPanel(ctx, surf, rest.join(" ").trim() || undefined)
        return
      }
      // bare /workflow → the registry index (the superseded eco listing).
      if (head === "list" || head === "") {
        await openListPanel(ctx, surf)
        return
      }
      ctx.toast(`workflow: unknown subcommand "${head}" — run <name> | status [id] | list`)
    },
  },
]

// ------------------------------------------------------------------ the default surface (real backend)

/** Local exec shim — @i-harness/exec is NOT a tui dependency, so the default
 * surface supplies the ExecService the workflow runner needs (it only calls
 * exec.run(cmd) + the abortSignal): node child_process spawn — the same trust
 * discipline as the loop's $EDITOR round-trip. The background-job surface is
 * served from a small local map so the facade is fully honest. */
interface LocalCmd {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  abortSignal?: AbortSignal
}
interface LocalResult { stdout: string; stderr: string; exitCode: number; timedOut: boolean }

function spawnLocal(cmd: LocalCmd, onDone: (r: LocalResult) => void): ReturnType<typeof spawn> {
  const child = spawn(cmd.argv[0] ?? "", cmd.argv.slice(1), {
    cwd: cmd.cwd,
    env: cmd.env !== undefined ? { ...process.env, ...cmd.env } : process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let timedOut = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8").replace(/\r\n/g, "\n") })
  child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8").replace(/\r\n/g, "\n") })
  const finish = (exitCode: number): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    onDone({ stdout, stderr, exitCode, timedOut })
  }
  timer = cmd.timeoutMs !== undefined
    ? setTimeout(() => { timedOut = true; try { child.kill() } catch { /* win32 */ } }, cmd.timeoutMs)
    : undefined
  cmd.abortSignal?.addEventListener("abort", () => { try { child.kill() } catch { /* win32 */ } }, { once: true })
  child.on("close", (code) => finish(code ?? -1))
  child.on("error", () => finish(-1))
  return child
}

/** The minimal ExecService-shaped object (structural — the workflow package's
 * WorkflowExecutorDeps check accepts it; @i-harness/exec is never imported). */
function createLocalExecService(): {
  run(cmd: LocalCmd): Promise<LocalResult>
  runBackground(cmd: LocalCmd): { jobId: string }
  getOutput(jobId: string): WorkflowJobView
  listJobs(): WorkflowJobView[]
  killJob(jobId: string): "cancellation-requested" | "already-finished"
} {
  let n = 0
  const jobs = new Map<string, { view: WorkflowJobView; handle?: ReturnType<typeof spawn> }>()
  return {
    async run(cmd: LocalCmd): Promise<LocalResult> {
      return await new Promise<LocalResult>((resolve) => { spawnLocal(cmd, resolve) })
    },
    runBackground(cmd: LocalCmd): { jobId: string } {
      const jobId = `local-${++n}`
      const view: WorkflowJobView = { id: jobId, status: "running", stdout: "", stderr: "" }
      const handle = spawnLocal(cmd, (r) => {
        const j = jobs.get(jobId)
        if (j === undefined || j.view.status !== "running") return
        j.view = {
          id: jobId,
          status: r.timedOut ? "killed" : r.exitCode === 0 ? "completed" : "error",
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
        }
      })
      jobs.set(jobId, { view, handle })
      return { jobId }
    },
    getOutput(jobId: string): WorkflowJobView {
      const j = jobs.get(jobId)
      if (j === undefined) throw new Error(`unknown job: ${jobId}`)
      return { ...j.view }
    },
    listJobs(): WorkflowJobView[] {
      return [...jobs.values()].map((j) => ({ ...j.view }))
    },
    killJob(jobId: string): "cancellation-requested" | "already-finished" {
      const j = jobs.get(jobId)
      if (j === undefined) throw new Error(`unknown job: ${jobId}`)
      if (j.view.status !== "running") return "already-finished"
      try { j.handle?.kill() } catch { /* win32 */ }
      j.view = { ...j.view, status: "killed" }
      return "cancellation-requested"
    },
  }
}

/** The real default host: @i-harness/workflow's registry (scan of
 * <workspace>/workflow/*.yml) + executor (one background job per run in the
 * process-shared store — real local spawns through the shim above). */
export function createDefaultWorkflowSurface(workspace?: string): WorkflowSurface {
  const registry = createWorkflowRegistry({ workspace: workspace ?? process.cwd() })
  const executor = createWorkflowExecutor({ exec: createLocalExecService() })
  const toEntry = (d: WorkflowDefinition): WorkflowListEntry => ({
    name: d.name,
    description: d.description,
    ...(d.whenToUse !== undefined ? { whenToUse: d.whenToUse } : {}),
    params: d.params ?? {},
    steps: d.steps.length,
  })
  return {
    async list() {
      return registry.list().map(toEntry)
    },
    async run(name, params) {
      const def = registry.get(name)
      if (def === undefined) throw new Error(`unknown workflow: ${name}`)
      const { runId, jobId } = executor.runWorkflow(def, params)
      return { run_id: runId, job_id: jobId, status: "running" }
    },
    async status(id) {
      return id === undefined ? executor.listJobs() : [executor.getOutput(id)]
    },
    async cancel(id) {
      return executor.killJob(id)
    },
  }
}
