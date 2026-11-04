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
import { randomUUID } from 'node:crypto'
import { isWorkflowStepFactory, type WorkflowStepFactory, type OwnedWorkflowStep } from '@i-harness/exec/direct-reservation'
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
  // M49 Task 12 review: the session owner that started this job (threaded
  // from the model-facing workflow_run tool's exec context). Undefined =
  // started outside a session (the run-level /workflow panel / standalone).
  owner?: string
}

// One run-level store of workflow background jobs. Job ids are `workflow-${n}`
// with a store-monotonic counter. Error contract mirrors ExecService exactly:
// unknown ids throw `unknown job: <id>` (the subagent job_* fallback chain
// tests /unknown job/i to decide whether to fall through).
export interface WorkflowJobStore {
  createJob(owner?: string): WorkflowJobEntry
  get(jobId: string): WorkflowJobEntry | undefined
  // Copy of the public BackgroundJobView shape (never the internal entry).
  view(jobId: string): BackgroundJobView
  subscribeJobs?(listener: () => void): () => void
  subscribeJob(jobId: string, listener: (view: BackgroundJobView) => void): () => void
  update(jobId: string, patch: Partial<Pick<WorkflowJobEntry, "status" | "stdout" | "stderr" | "exitCode">>): void
  list(): BackgroundJobView[]
  kill(jobId: string): "cancellation-requested" | "already-finished"
}

export function createWorkflowJobStore(): WorkflowJobStore {
  let counter = 0
  const jobs = new Map<string, WorkflowJobEntry>()
  const listeners = new Map<string, Set<(view: BackgroundJobView) => void>>()
  const collection = new Set<() => void>()

  function publish(job: WorkflowJobEntry): void {
    for (const listener of [...collection]) { try { listener() } catch {} }
    for (const listener of [...listeners.get(job.id) ?? []]) {
      try { listener(toView(job)) } catch { /* Observers cannot interrupt the runner. */ }
    }
  }

  function toView(job: WorkflowJobEntry): BackgroundJobView {
    return {
      id: job.id,
      status: job.status,
      stdout: job.stdout,
      stderr: job.stderr,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.owner !== undefined ? { owner: job.owner } : {}),
    }
  }

  /** Completed runs are retained for job_output, but not forever: the store is a
   * process-wide singleton, so an editor that runs workflows all day used to
   * accumulate every run's stdout/stderr (and its AbortController) until exit. */
  const MAX_RETAINED_FINISHED_JOBS = 64
  function evictFinished(): void {
    const finished = [...jobs.values()].filter(job => job.status !== "running" && (listeners.get(job.id)?.size ?? 0) === 0)
    for (let index = 0; index < finished.length - MAX_RETAINED_FINISHED_JOBS; index += 1) {
      const job = finished[index]!
      jobs.delete(job.id)
      listeners.delete(job.id)
    }
  }

  return {
    createJob(owner?: string): WorkflowJobEntry {
      evictFinished()
      counter += 1
      const job: WorkflowJobEntry = { id: `workflow-${counter}`, status: "running", stdout: "", stderr: "", controller: new AbortController(), ...(owner !== undefined ? { owner } : {}) }
      jobs.set(job.id, job)
      publish(job)
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
    subscribeJobs(listener) { collection.add(listener); return () => { collection.delete(listener) } },
    subscribeJob(jobId, listener) {
      if (!jobs.has(jobId)) throw new Error(`unknown job: ${jobId}`)
      let group = listeners.get(jobId)
      if (!group) listeners.set(jobId, group = new Set())
      group.add(listener)
      return () => { group.delete(listener); if (group.size === 0 && listeners.get(jobId) === group) listeners.delete(jobId) }
    },
    update(jobId, patch) {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      const { status, exitCode, ...output } = patch
      if (job.status === "killed" && Object.keys(output).length === 0) return
      Object.assign(job, output, job.status === "killed" ? {} : {
        ...(status === undefined ? {} : { status }), ...(exitCode === undefined ? {} : { exitCode }),
      })
      publish(job)
      if (job.status !== "running") evictFinished()
    },
    list(): BackgroundJobView[] {
      return [...jobs.values()].map(toView)
    },
    kill(jobId: string): "cancellation-requested" | "already-finished" {
      const job = jobs.get(jobId)
      if (!job) throw new Error(`unknown job: ${jobId}`)
      if (job.status !== "running") return "already-finished"
      job.status = "killed" // immediate, like ExecService; late loop writes are guarded no-ops
      publish(job)
      job.controller.abort()
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

/** Loop observations only. Neither status nor this join certifies native cleanup. */
export interface WorkflowLoopFailure {
  readonly phase: 'attempt' | 'loop'
  readonly step?: number
  readonly attempt?: number
  readonly cause: unknown
}
export interface WorkflowLoopCompletion {
  readonly kind: 'loop-finished'
  readonly cleanup: 'unqualified' | 'clean' | 'recovery-required'
  readonly status: BackgroundJobStatus
  readonly dispatch: 'not-dispatched' | 'dispatched' | 'unknown'
  readonly resultCompleteness:'complete'|'source-limited'
  readonly result: import('../../core-session/src/events/workflow-delivery.ts').WorkflowRunResult
  readonly failures: readonly WorkflowLoopFailure[]
}
export interface OwnedWorkflowRunHandle extends WorkflowRunHandle {
  readonly invocationId: string
  join(): Promise<WorkflowLoopCompletion>
  reconcile(): Promise<WorkflowLoopCompletion>
}
const originalWorkflowCompletions=new WeakMap<object,WeakSet<object>>()
/** Only the original reserved run can qualify its own joined completion. */
export function isOriginalWorkflowCompletion(run:object,value:object):value is WorkflowLoopCompletion{return !!run&&!!value&&originalWorkflowCompletions.get(run)?.has(value)===true}
export interface WorkflowReservation {
  readonly invocationId: string
  start(): OwnedWorkflowRunHandle
  join(): Promise<WorkflowLoopCompletion>
}

/** Allocation/validation only: no store publication, Exec call or observer effect. */
export function reserveWorkflowIn(def: WorkflowDefinition, params: Record<string, string>, exec: ExecService,
  store: WorkflowJobStore, owner?: string, defaultCwd?: string, steps?: WorkflowStepFactory): WorkflowReservation {
  if (steps && !isWorkflowStepFactory(steps)) throw new Error('Original Workflow step factory required')
  const values = resolveParams(def, params)
  const captured = { ...def, steps: def.steps.map(step => ({ ...step,
    ...(step.env ? { env: { ...step.env } } : {}), ...(step.retry ? { retry: { ...step.retry } } : {}),
  })) }
  const invocationId = randomUUID(), completion = Promise.withResolvers<WorkflowLoopCompletion>()
  void completion.promise.catch(() => {})
  let handle: OwnedWorkflowRunHandle | undefined, starting = false, failed = false, failure: unknown
  const ownedSteps: OwnedWorkflowStep[] = []
  const reservation: WorkflowReservation = Object.freeze({ invocationId,
    start() {
      if (this !== reservation) throw new Error('Foreign Workflow reservation receiver')
      if (handle) return handle
      if (failed) throw failure
      if (starting) throw new Error('Workflow reservation start in progress')
      starting = true
      try {
        const job = startWorkflowLoop(captured, values, exec, store, owner, defaultCwd, completion.resolve, steps, ownedSteps, invocationId)
        const original: OwnedWorkflowRunHandle = Object.freeze({ ...job, invocationId,
          join() { if (this !== original) throw new Error('Foreign Workflow handle receiver'); return completion.promise.then(value=>{originalWorkflowCompletions.get(original)!.add(value);return value}) },
          async reconcile() {
            if (this !== original) throw new Error('Foreign Workflow handle receiver')
            const prior = await completion.promise
            if(!ownedSteps.length){originalWorkflowCompletions.get(original)!.add(prior);return prior}
            let clean = true, dispatched = false, unknown = false
            for (const step of ownedSteps) { const result = await step.reconcile(); if (result.kind !== 'clean') {clean = false;unknown = true} else if(result.execution==='dispatched')dispatched=true;else if(result.execution==='unknown')unknown=true }
            if (clean) { for (const step of ownedSteps) step.release(); ownedSteps.length = 0 }
            const observed=Object.freeze({ ...prior, cleanup: steps ? clean ? 'clean' as const : 'recovery-required' as const : 'unqualified' as const, dispatch:!steps||unknown?'unknown' as const:dispatched?'dispatched' as const:'not-dispatched' as const });originalWorkflowCompletions.get(original)!.add(observed);return observed
          },
        })
        originalWorkflowCompletions.set(original,new WeakSet());return handle = original
      } catch (cause) { failed = true; failure = cause; completion.reject(cause); throw cause }
    },
    join() { if (this !== reservation) throw new Error('Foreign Workflow reservation receiver'); return completion.promise },
  })
  return reservation
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

function stepCommand(step: WorkflowStep, values: Record<string, string>, defaultCwd?: string): ExecCommand {
  const cmd: ExecCommand = { argv: getArgv(interpolate(step.command, values)), abortSignal: undefined }
  // D1 (m55): an unset step cwd falls back to the executor's default (the
  // assembly workspace) — an unset-cwd step must not operate on the process
  // cwd tree. Absent default → no cwd field (exec's own contract).
  const cwd = step.cwd !== undefined ? interpolate(step.cwd, values) : defaultCwd
  if (cwd !== undefined) cmd.cwd = cwd
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
export function runWorkflowIn(
  def: WorkflowDefinition,
  params: Record<string, string>,
  exec: ExecService,
  store: WorkflowJobStore,
  // M49 Task 12 review: the session that started this run (the model-facing
  // tool's exec context) — the per-session task projection attributes rows by
  // it. Undefined = non-session starter (panel/standalone).
  owner?: string,
  // D1 (m55): default cwd for steps that do not declare one — the mount's
  // workspace. Absent → exec's own contract (process cwd).
  defaultCwd?: string,
  steps?: WorkflowStepFactory,
): OwnedWorkflowRunHandle {
  return reserveWorkflowIn(def, params, exec, store, owner, defaultCwd, steps).start()
}

function startWorkflowLoop(def: WorkflowDefinition, values: Record<string, string>, exec: ExecService,
  store: WorkflowJobStore, owner: string | undefined, defaultCwd: string | undefined,
  completed: (value: WorkflowLoopCompletion) => void, stepFactory?: WorkflowStepFactory, ownedSteps: OwnedWorkflowStep[] = [], invocationId = ''): WorkflowRunHandle {
  const job = store.createJob(owner)
  const { controller } = job
  const steps = def.steps
  const total = steps.length
  const failures: WorkflowLoopFailure[] = []
  let cleanup: WorkflowLoopCompletion['cleanup'] = stepFactory ? 'clean' : 'unqualified', dispatched=false, unknown=!stepFactory
  let sourceLimited=false
  const stepResults:import('../../core-session/src/events/workflow-delivery.ts').WorkflowRunResult['steps']=[]

  function setStatus(status: BackgroundJobStatus, exitCode: number): void {
    if (job.status !== "running") return // killed runs stay killed
    store.update(job.id, { status, exitCode })
  }

  function skipRest(from: number): void {
    for (let i = from; i < total; i++) appendLine(job, `[step ${i + 1}/${total} ${steps[i]!.name}] skipped`)
    store.update(job.id, { stdout: job.stdout })
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
        let owned: OwnedWorkflowStep | undefined
        appendLine(job, `[step ${i + 1}/${total} ${step.name}] started`)
        store.update(job.id, { stdout: job.stdout })
        try {
          const cmd = stepCommand(step, values, defaultCwd)
          cmd.abortSignal = controller.signal
          if (stepFactory) { owned = stepFactory.create(cmd); ownedSteps.push(owned); result = await owned.run() }
          else result = await exec.run(cmd)
        } catch (e) {
          failures.push(Object.freeze({ phase: 'attempt', step: i, attempt, cause: e }))
          // exec.run can reject (e.g. sandbox unavailable) — translate into an
          // ordinary step failure so the failure discipline applies uniformly.
          result = { stdout: "", stderr: e instanceof Error ? e.message : String(e), exitCode: -1, timedOut: false }
        }
        if(result.truncated?.stdout||result.truncated?.stderr||result.stdoutSpillPath||result.stderrSpillPath||result.outputDiagnostics?.outputAbandoned||result.outputDiagnostics?.discardedOutputBytes||result.retentionFailure||result.stream?.stopReason)sourceLimited=true
        stepResults.push({step:i,attempt,outcome:controller.signal.aborted?'canceled':result.exitCode===0?'succeeded':'failed',exitCode:result.exitCode,timedOut:result.timedOut,stdout:result.stdout,stderr:result.stderr})
        if (owned) {
          const ownership = await owned.join()
          if (ownership.kind !== 'clean') {
            unknown=true;cleanup = 'recovery-required'
            failures.push(Object.freeze({ phase: 'loop', step: i, attempt, cause: ownership.cause }))
            setStatus('error', -1); skipRest(i + 1); return
          }
          if(ownership.execution==='dispatched')dispatched=true;else if(ownership.execution==='unknown')unknown=true
        }
        if (controller.signal.aborted) {
          skipRest(i + 1)
          return // killJob already set status; late writes are guarded no-ops
        }
        if (result.exitCode === 0) break
        appendLine(job, `[step ${i + 1}/${total} ${step.name}] failed(exit=${result.exitCode})`)
        store.update(job.id, { stdout: job.stdout })
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
        store.update(job.id, { stdout: job.stdout })
        continue
      }
      if (final.stderr.length > 0) job.stderr += final.stderr
      store.update(job.id, { stdout: job.stdout, stderr: job.stderr })
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
    failures.push(Object.freeze({ phase: 'loop', cause: e }))
    try {
      job.stderr += `workflow runner error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`
      setStatus("error", -1)
    } catch (cause) { failures.push(Object.freeze({ phase: 'loop', cause })) }
  }).then(() => {
    // Original run-disposal boundary. No aggregate output proof is emitted.
    if (cleanup === 'clean') { for (const step of ownedSteps) step.release(); ownedSteps.length = 0 }
    completed(Object.freeze({ kind: 'loop-finished', cleanup,
    status: job.status,resultCompleteness:sourceLimited?'source-limited':'complete',dispatch:unknown?'unknown':dispatched?'dispatched':'not-dispatched',result:Object.freeze({version:1,kind:'workflow-run-result',invocationId,steps:Object.freeze(stepResults.map(value=>Object.freeze({...value}))) as unknown as typeof stepResults,stdout:job.stdout,stderr:job.stderr}), failures: Object.freeze([...failures]),
  })) })

  return { runId: job.id, jobId: job.id }
}

// Standalone entry (spec §3.2 signature): runs against the process-shared
// store, so jobs started this way are queryable via any executor's
// getOutput/listJobs/killJob. `owner` attributes the run (the per-session
// projection filters on it).
export function runWorkflow(def: WorkflowDefinition, params: Record<string, string>, exec: ExecService, owner?: string, defaultCwd?: string): OwnedWorkflowRunHandle {
  return runWorkflowIn(def, params ?? {}, exec, sharedJobs, owner, defaultCwd)
}

// Executor facade — the object Task 3's subagent job_* third layer consumes
// (deps.workflow: { getOutput, listJobs, killJob, runWorkflow }). Same method
// contract as ExecService's job surface, restricted to workflow- ids.
export interface WorkflowExecutor {
  runWorkflow(def: WorkflowDefinition, params?: Record<string, string>, owner?: string): WorkflowRunHandle
  getOutput(jobId: string): BackgroundJobView
  subscribeJobs?(listener: () => void): () => void
  subscribeJob(jobId: string, listener: (view: BackgroundJobView) => void): () => void
  listJobs(): BackgroundJobView[]
  killJob(jobId: string): "cancellation-requested" | "already-finished"
}

interface WorkflowExecutorDeps {
  exec: ExecService
  steps?: WorkflowStepFactory
  // Inject an isolated store (tests); default = the shared run-level store.
  jobs?: WorkflowJobStore
  // D1 (m55): default cwd for steps without one — the mount's workspace.
  cwd?: string
}

export function createWorkflowExecutor(deps: WorkflowExecutorDeps): Omit<WorkflowExecutor, 'runWorkflow'> & {
  reserveWorkflow(def: WorkflowDefinition, params?: Record<string, string>, owner?: string): WorkflowReservation
  runWorkflow(def: WorkflowDefinition, params?: Record<string, string>, owner?: string): OwnedWorkflowRunHandle
} {
  const jobs = deps.jobs ?? sharedJobs
  return {
    reserveWorkflow(def, params = {}, owner) { return reserveWorkflowIn(def, params, deps.exec, jobs, owner, deps.cwd, deps.steps) },
    runWorkflow(def: WorkflowDefinition, params?: Record<string, string>, owner?: string): OwnedWorkflowRunHandle {
      return runWorkflowIn(def, params ?? {}, deps.exec, jobs, owner, deps.cwd, deps.steps)
    },
    getOutput(jobId: string): BackgroundJobView {
      return jobs.view(jobId)
    },
    subscribeJobs(listener) { return jobs.subscribeJobs?.(listener) ?? (() => {}) },
    subscribeJob(jobId, listener) { return jobs.subscribeJob(jobId, listener) },
    listJobs(): BackgroundJobView[] {
      return jobs.list()
    },
    killJob(jobId: string): "cancellation-requested" | "already-finished" {
      return jobs.kill(jobId)
    },
  }
}
