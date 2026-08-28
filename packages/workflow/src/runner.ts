// Workflow runner (spec §3.2 "執行 single background job"): an in-process
// async loop walks the definition's steps sequentially, spawning each one via
// ExecService.run(), while the WHOLE run is surfaced as ONE background job
// (id `workflow-${n}`, BackgroundJobView-shaped) in a workflow-owned job
// store. That store is the job_* third layer (spec §3.3): the subagent's
// job_output/job_list/job_kill fallback chain recognizes `workflow-` ids and
// queries this store — so getOutput/listJobs/killJob mirror ExecService's
// exact contract, INCLUDING the `unknown job: <id>` error message the
// fallback chain pattern-matches on.
//
// SHAPE (chosen per task ruling 6): the job map lives in a WorkflowJobStore;
// `createWorkflowExecutor({ exec, jobs? })` owns a store and exposes
// runWorkflow/getOutput/listJobs/killJob (ExecService-like facade). The
// registry stays definitions-only. Both the executor and the standalone
// `runWorkflow` default to ONE process-shared store — the run-level singleton
// (ruling M24b-P3) — so every workflow job in the process is visible through
// any executor; tests inject an isolated store for hermeticity.
//
// Progress lines go into the job output stream, one per step event:
//   [step i/N <name>] started        (every attempt, retries included)
//   [step i/N <name>] ok
//   [step i/N <name>] failed(exit=N)
//   [step i/N <name>] skipped        (steps after a stop-failure or a kill)
// Step stdout (and stderr of failed steps) follows as-is.
//
// Failure discipline (dsh absorb): ANY step failure marks the run errored —
// never partial-as-success. `on_failure: continue` keeps the loop going but
// does not launder the failure. Kill = run-level AbortController → the
// current step's exec.run abort signal (exec kills the process tree).
//
// `${param}` interpolation is plain string substitution BEFORE spawn — trust
// level identical to the bash tool (params are model-authored command text,
// not escaped). Only declared params interpolate; unknown ${...} is left
// verbatim so the model can see the unresolved hole.
import { getArgv } from "@i-harness/shell"
import type { BackgroundJobStatus, BackgroundJobView, ExecCommand, ExecResult, ExecService } from "@i-harness/exec"
import type { WorkflowDefinition, WorkflowStep } from "./definition.ts"

export type { WorkflowDefinition, WorkflowStep } from "./definition.ts"

export interface WorkflowJobEntry {
  id: string
  status: BackgroundJobStatus
  stdout: string
  stderr: string
  exitCode?: number
  // Run-level cancellation: aborting kills the CURRENT step's process tree.
  controller: AbortController
}

// One run-level store of workflow background jobs. Job ids are `workflow-${n}`
// with a store-monotonic counter. Error contract mirrors ExecService exactly:
// unknown ids throw `unknown job: <id>` (the subagent job_* fallback chain
// tests /unknown job/i to decide whether to fall through).
export interface WorkflowJobStore {
  createJob(): WorkflowJobEntry
  get(jobId: string): WorkflowJobEntry | undefined
  // Copy of the public BackgroundJobView shape (never the internal entry).
  view(jobId: string): BackgroundJobView
  list(): BackgroundJobView[]
  kill(jobId: string): "cancellation-requested" | "already-finished"
}

export function createWorkflowJobStore(): WorkflowJobStore {
  let counter = 0
  const jobs = new Map<string, WorkflowJobEntry>()

  function toView(job: WorkflowJobEntry): BackgroundJobView {
    return {
      id: job.id,
      status: job.status,
      stdout: job.stdout,
      stderr: job.stderr,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    }
  }

  return {
    createJob(): WorkflowJobEntry {
      counter += 1
      const job: WorkflowJobEntry = { id: `workflow-${counter}`, status: "running", stdout: "", stderr: "", controller: new AbortController() }
      jobs.set(job.id, job)
      return job
    },
    get(jobId: string): WorkflowJobEntry | undefined {
      return jobs.get(jobId)
    },
    view(jobId: string): BackgroundJobView {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      return toView(job)
    },
    list(): BackgroundJobView[] {
      return [...jobs.values()].map(toView)
    },
    kill(jobId: string): "cancellation-requested" | "already-finished" {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      if (job.status !== "running") return "already-finished"
      job.controller.abort()
      job.status = "killed" // immediate, like ExecService; late loop writes are guarded no-ops
      return "cancellation-requested"
    },
  }
}

// Process-shared default store: the run-level singleton (ruling M24b-P3).
const sharedJobs = createWorkflowJobStore()

export interface WorkflowRunHandle {
  // v0: runId === jobId — one background job per run (single-job semantics).
  // Distinct fields future-proof the shape for durable run records (spec §2.2
  // defers those).
  runId: string
  jobId: string
}

function interpolate(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{([^}]+)\}/g, (match, key: string) => (key in values ? values[key]! : match))
}

function resolveParams(def: WorkflowDefinition, params: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [name, spec] of Object.entries(def.params ?? {})) {
    const provided = Object.hasOwn(params, name) ? params[name] : undefined
    if (provided !== undefined) {
      values[name] = provided
    } else if (spec.default !== undefined) {
      values[name] = spec.default
    } else if (spec.required === true) {
      // Fail loud BEFORE any job is created — a missing required param is a
      // caller error, not a runtime condition of the run.
      throw new Error(`workflow '${def.name}': missing required param '${name}'`)
    }
    // No value and not required → the param simply never interpolates;
    // unresolved ${name} stays visible in the command text.
  }
  return values
}

function appendLine(job: WorkflowJobEntry, line: string): void {
  job.stdout += line + "\n"
}

function appendRaw(job: WorkflowJobEntry, text: string): void {
  // Stream step output as-is; keep the buffer line-oriented for progress lines.
  job.stdout += text.endsWith("\n") ? text : text + "\n"
}

function stepCommand(step: WorkflowStep, values: Record<string, string>): ExecCommand {
  const cmd: ExecCommand = { argv: getArgv(interpolate(step.command, values)), abortSignal: undefined }
  if (step.cwd !== undefined) cmd.cwd = interpolate(step.cwd, values)
  if (step.env !== undefined) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(step.env)) env[k] = interpolate(v, values)
    cmd.env = env
  }
  if (step.timeout_ms !== undefined) cmd.timeoutMs = step.timeout_ms
  return cmd
}

// Core run loop. Registers the run's job in `store` synchronously and returns
// immediately; the async loop then walks the steps. All status writes are
// guarded so a job killed mid-step is never overwritten (killJob set it).
export function runWorkflowIn(def: WorkflowDefinition, params: Record<string, string>, exec: ExecService, store: WorkflowJobStore): WorkflowRunHandle {
  const values = resolveParams(def, params)
  const job = store.createJob()
  const { controller } = job
  const steps = def.steps
  const total = steps.length

  function setStatus(status: BackgroundJobStatus, exitCode: number): void {
    if (job.status !== "running") return // killed runs stay killed
    job.status = status
    job.exitCode = exitCode
  }

  function skipRest(from: number): void {
    for (let i = from; i < total; i++) appendLine(job, `[step ${i + 1}/${total} ${steps[i]!.name}] skipped`)
  }

  void (async () => {
    let firstFailedExit: number | undefined
    for (let i = 0; i < total; i++) {
      const step = steps[i]!
      if (controller.signal.aborted) {
        skipRest(i)
        return
      }
      const attempts = Math.max(1, step.retry?.attempts ?? 1)
      let result: ExecResult | undefined
      for (let attempt = 1; attempt <= attempts; attempt++) {
        appendLine(job, `[step ${i + 1}/${total} ${step.name}] started`)
        try {
          const cmd = stepCommand(step, values)
          cmd.abortSignal = controller.signal
          result = await exec.run(cmd)
        } catch (e) {
          // exec.run can reject (e.g. sandbox unavailable) — translate into an
          // ordinary step failure so the failure discipline applies uniformly.
          result = { stdout: "", stderr: e instanceof Error ? e.message : String(e), exitCode: -1, timedOut: false }
        }
        if (controller.signal.aborted) {
          skipRest(i + 1)
          return // killJob already set status; late writes are guarded no-ops
        }
        if (result.exitCode === 0) break
        appendLine(job, `[step ${i + 1}/${total} ${step.name}] failed(exit=${result.exitCode})`)
        if (attempt < attempts) {
          const backoff = step.retry?.backoff_ms ?? 0
          if (backoff > 0) await new Promise((r) => setTimeout(r, backoff))
          if (controller.signal.aborted) {
            skipRest(i + 1)
            return
          }
        }
      }
      const final = result!
      if (final.stdout.length > 0) appendRaw(job, final.stdout)
      if (final.exitCode === 0) {
        appendLine(job, `[step ${i + 1}/${total} ${step.name}] ok`)
        continue
      }
      if (final.stderr.length > 0) job.stderr += final.stderr
      firstFailedExit ??= final.exitCode
      if ((step.on_failure ?? "stop") === "stop") {
        skipRest(i + 1)
        setStatus("error", firstFailedExit)
        return
      }
      // on_failure: continue — the failure is recorded (above + exitCode), the
      // loop proceeds; the run still ends errored (never partial-as-success).
    }
    setStatus(firstFailedExit !== undefined ? "error" : "completed", firstFailedExit ?? 0)
  })().catch((e: unknown) => {
    // Defensive: the loop itself must never reject unhandled. Surface the bug
    // on the job and fail the run.
    job.stderr += `workflow runner error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`
    setStatus("error", -1)
  })

  return { runId: job.id, jobId: job.id }
}

// Standalone entry (spec §3.2 signature): runs against the process-shared
// store, so jobs started this way are queryable via any executor's
// getOutput/listJobs/killJob.
export function runWorkflow(def: WorkflowDefinition, params: Record<string, string>, exec: ExecService): WorkflowRunHandle {
  return runWorkflowIn(def, params ?? {}, exec, sharedJobs)
}

// Executor facade — the object Task 3's subagent job_* third layer consumes
// (deps.workflow: { getOutput, listJobs, killJob, runWorkflow }). Same method
// contract as ExecService's job surface, restricted to workflow- ids.
export interface WorkflowExecutor {
  runWorkflow(def: WorkflowDefinition, params?: Record<string, string>): WorkflowRunHandle
  getOutput(jobId: string): BackgroundJobView
  listJobs(): BackgroundJobView[]
  killJob(jobId: string): "cancellation-requested" | "already-finished"
}

export interface WorkflowExecutorDeps {
  exec: ExecService
  // Inject an isolated store (tests); default = the shared run-level store.
  jobs?: WorkflowJobStore
}

export function createWorkflowExecutor(deps: WorkflowExecutorDeps): WorkflowExecutor {
  const jobs = deps.jobs ?? sharedJobs
  return {
    runWorkflow(def: WorkflowDefinition, params?: Record<string, string>): WorkflowRunHandle {
      return runWorkflowIn(def, params ?? {}, deps.exec, jobs)
    },
    getOutput(jobId: string): BackgroundJobView {
      return jobs.view(jobId)
    },
    listJobs(): BackgroundJobView[] {
      return jobs.list()
    },
    killJob(jobId: string): "cancellation-requested" | "already-finished" {
      return jobs.kill(jobId)
    },
  }
}
