import type { ExecutionSettlement, StopReason } from "@i-harness/sandbox"
import type { ExecutionSupervisor } from "../execution-supervisor.ts"
import type { ExecExecutionHost, ExecService, ExecServiceOptions } from "../index.ts"
import type { Capture } from "../capture/contracts.ts"
import type { Job } from "./contracts.ts"
import { createCaptureFactory } from "../capture/output.ts"
import { createTransportLaunch } from "../transport-launch.ts"
import { createJobObservation } from "./observation.ts"
import { view } from "./views.ts"

/** The sole job registry, ID allocator and service disposal owner. */
export function createJobService(options: ExecServiceOptions, host: ExecExecutionHost, supervisor: ExecutionSupervisor): ExecService {
  const jobs = new Map<string, Job>()
  let nextJob = 0
  let disposed = false

  const { launchTransport, canAccess } = createTransportLaunch(options, host, supervisor, () => disposed)
  const makeCapture = createCaptureFactory(options, supervisor, launchTransport)
  const observe = (capture: Capture) => { if (capture.frames) void retain(capture) }
  /** Bind then settle this exact original capture once; a later query reuses
   * the same committed dependency instead of triggering a second settlement. */
  const retention = new WeakMap<Capture, Promise<void>>()
  function retain(capture: Capture): Promise<void> {
    const existing = retention.get(capture)
    if (existing) return existing
    const frames = capture.frames, owner = options.resultRetention
    const next = (async () => {
      if (!frames || !owner) return
      const observation = await owner.observe(frames)
      const job = [...jobs.values()].find(candidate => candidate.capture === capture)
      if (!job) return
      if (observation.kind === 'ready') job.retained = observation.dependency
      else job.retentionFailure = 'recovery-required'
      if (job.retained?.retention.kind === 'unavailable') job.retentionFailure = 'unavailable'
    })().catch(() => {
      const job = [...jobs.values()].find(candidate => candidate.capture === capture)
      if (job) job.retentionFailure = 'recovery-required'
    })
    retention.set(capture, next)
    return next
  }
  const run = createJobObservation({ makeCapture, registerJob, isDisposed: () => disposed, observe })

  function cancelExecution(id: string, reason: StopReason): Promise<ExecutionSettlement> {
    const execution = supervisor.list().find(entry => entry.id === id)
    if (!execution || !canAccess(execution.policy.owner)) return Promise.reject(new Error("Unknown execution for caller"))
    return supervisor.cancel(id, reason)
  }

  function registerJob(capture: Capture): string {
    const id = `bash-${++nextJob}`
    const job: Job = { id, capture, status: "running", owner: capture.execution.policy.owner, listeners: new Set() }
    jobs.set(id, job)
    void capture.execution.handle.rootExited.then(root => { job.root = root; publish(job) }, cause => { job.failure = String(cause); publish(job) })
    void capture.execution.handle.settled.then(settlement => {
      job.settlement = settlement
      if (settlement.kind === "incomplete") {
        job.status = "running"
        job.cleanupDetail = `${settlement.phase}: ${settlement.detail}`
      }
      publish(job)
    }, cause => { job.status = "running"; job.cleanupDetail = String(cause); publish(job) })
    // Settle the original frame capture before the terminal view is published,
    // so any later job query returns the same source/ref revision without
    // relying on somebody asking for the output first.
    const settle = () => { job.retention ??= retain(capture); return job.retention }
    void capture.complete.then(async result => {
      job.exitCode = result.exitCode
      job.failure = undefined
      job.cleanupDetail = undefined
      job.status = result.timedOut ? "killed" : result.exitCode === 0 ? "completed" : "error"
      await settle()
      publish(job)
    }, async cause => {
      if (job.settlement?.kind === "incomplete" || job.cleanupDetail !== undefined) {
        job.status = "running"
        if (job.settlement?.kind === "incomplete") job.cleanupDetail = `${job.settlement.phase}: ${job.settlement.detail}`
      } else {
        job.failure = cause instanceof Error ? cause.message : String(cause)
        job.status = "error"
      }
      await settle()
      publish(job)
    })
    return id
  }

  function publish(job: Job): void {
    // Observers receive independent views and cannot interrupt owner transitions.
    for (const listener of [...job.listeners]) {
      try { listener(view(job)) } catch { /* The producer retains ownership. */ }
    }
  }

  async function settledAfterRetirement(job: Job): Promise<boolean> {
    if (job.settlement?.kind === "settled") {
      job.cleanupDetail = undefined
      return true
    }
    // The supervisor removes entries only after the driver's full settlement.
    // Its observer can retire the entry before this job-view observer runs.
    if (supervisor.list().some(entry => entry.id === job.capture.execution.id)) return false
    const settlement = await job.capture.execution.handle.settled
    job.settlement = settlement
    if (settlement.kind !== "settled") {
      job.cleanupDetail = `${settlement.phase}: ${settlement.detail}`
      throw new Error("Execution owner retired an incomplete settlement")
    }
    job.cleanupDetail = undefined
    return true
  }

  return {
    run: run as ExecService["run"],
    async runBackground(command) { const capture = await makeCapture(command, undefined, true); return { jobId: registerJob(capture) } },
    getOutput(jobId) {
      const job = jobs.get(jobId)
      if (!job || !canAccess(job.owner)) throw new Error(`unknown job: ${jobId}`)
      if (job.status !== 'running') observe(job.capture)
      return view(job)
    },
    subscribeJob(jobId, listener) {
      const job = jobs.get(jobId)
      if (!job || !canAccess(job.owner)) throw new Error(`unknown job: ${jobId}`)
      job.listeners.add(listener)
      return () => { job.listeners.delete(listener) }
    },
    listJobs() {
      return [...jobs.values()].filter(job => canAccess(job.owner)).map(job => { if (job.status !== 'running') observe(job.capture); return view(job) })
    },
    async killJob(jobId) {
      const job = jobs.get(jobId)
      if (!job || !canAccess(job.owner)) throw new Error(`unknown job: ${jobId}`)
      if (await settledAfterRetirement(job)) return "already-finished"
      if (job.status !== "running" && job.settlement?.kind !== "incomplete") return "already-finished"
      let settlement: ExecutionSettlement
      try { settlement = await supervisor.cancel(job.capture.execution.id, "cancelled") }
      catch (cause) {
        if (await settledAfterRetirement(job)) return "already-finished"
        job.status = "running"
        job.cleanupDetail = cause instanceof Error ? cause.message : String(cause)
        publish(job)
        throw cause
      }
      job.settlement = settlement
      if (settlement.kind !== "settled") {
        job.status = "running"
        job.cleanupDetail = `${settlement.phase}: ${settlement.detail}`
        publish(job)
        throw new Error(`Execution cancellation incomplete: ${settlement.detail}`)
      }
      await job.capture.complete.catch(() => {})
      job.root = settlement.root
      job.exitCode = settlement.root.exitCode ?? -1
      job.failure = undefined
      job.cleanupDetail = undefined
      job.status = "killed"
      publish(job)
      return "cancellation-requested"
    },
    launchTransport, cancelExecution,
    async dispose() {
      disposed = true
      try {
        await supervisor.dispose()
        // Close join: every already-started capture settles its own frame
        // dependency before the producer-side services are torn down.
        await Promise.allSettled([...jobs.values()].map(job => job.retention ?? job.capture.complete.then(() => retain(job.capture), () => undefined)))
        await host.dispose?.()
      } finally { for (const job of jobs.values()) job.listeners.clear() }
    },
  }
}
