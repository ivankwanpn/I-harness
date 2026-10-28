import type { ExecutionSettlement, StopReason } from "@i-harness/sandbox"
import { randomUUID } from 'node:crypto'
import type { ExecutionSupervisor } from "../execution-supervisor.ts"
import type { ExecExecutionHost, NativeExecService, ExecServiceOptions, NativeJobIdentity } from "../index.ts"
import type { Capture } from "../capture/contracts.ts"
import type { Job } from "./contracts.ts"
import { createCaptureFactory } from "../capture/output.ts"
import { createTransportLaunch } from "../transport-launch.ts"
import { createJobObservation } from "./observation.ts"
import { view } from "./views.ts"
import { createJobRetention } from './retention.ts'

/** The sole job registry, ID allocator and service disposal owner. */
export function createJobService(options: ExecServiceOptions, host: ExecExecutionHost, supervisor: ExecutionSupervisor): NativeExecService {
  const jobs = new Map<string, Job>()
  const captureJobs = new WeakMap<Capture, Job>()
  const captureInstances = new WeakMap<Capture, string>()
  let nextJob = 0
  let disposed = false

  const { launchTransport, canAccess } = createTransportLaunch(options, host, supervisor, () => disposed)
  const createCapture = createCaptureFactory(options, supervisor, launchTransport)
  const retention = createJobRetention(options.resultRetention, capture => captureJobs.get(capture))
  const makeCapture: typeof createCapture = async (...args) => {
    // Allocate synchronously before admission/native launch, including foreground
    // captures which may later promote. Failed launches publish no identity.
    const instanceId = randomUUID()
    if ([...jobs.values()].some(job => job.instanceId === instanceId)) throw new Error('Native job instance collision')
    const capture = await createCapture(...args)
    captureInstances.set(capture, instanceId)
    return retention.track(capture)
  }
  const { observe, record } = retention

  const run = createJobObservation({ makeCapture, registerJob, isDisposed: () => disposed, observe })

  function cancelExecution(id: string, reason: StopReason): Promise<ExecutionSettlement> {
    const execution = supervisor.list().find(entry => entry.id === id)
    if (!execution || !canAccess(execution.policy.owner)) return Promise.reject(new Error("Unknown execution for caller"))
    return supervisor.cancel(id, reason)
  }

  function registerJob(capture: Capture): NativeJobIdentity {
    const existing = captureJobs.get(capture)
    if (existing) return existing.nativeJob
    const instanceId = captureInstances.get(capture)
    if (!instanceId) throw new Error('Missing original native job instance')
    if ([...jobs.values()].some(job => job.instanceId === instanceId)) throw new Error('Native job instance collision')
    const id = "bash-" + (++nextJob)
    const nativeJob: NativeJobIdentity = Object.freeze({ version: 1, instanceId, jobId: id,
      ownerSessionId: capture.execution.policy.owner.sessionId, sourceId: `process:${capture.execution.id}` })
    const job: Job = { id, instanceId, nativeJob, capture, status: "running", owner: capture.execution.policy.owner, listeners: new Set() }
    jobs.set(id, job)
    captureJobs.set(capture, job)
    void capture.execution.handle.rootExited.then(root => { job.root = root; publish(job) }, cause => { job.failure = String(cause); publish(job) })
    void capture.execution.handle.settled.then(settlement => {
      job.settlement = settlement
      if (settlement.kind === "incomplete") {
        job.status = "running"
        job.cleanupDetail = settlement.phase + ": " + settlement.detail
      }
      publish(job)
    }, cause => { job.status = "running"; job.cleanupDetail = String(cause); publish(job) })
    // Passive owner settlement: no observer claim. A later genuine reader still
    // registers its own source when it asks for this job.
    void capture.complete.then(async result => {
      job.exitCode = result.exitCode
      job.failure = undefined
      job.cleanupDetail = undefined
      job.status = result.timedOut ? "killed" : result.exitCode === 0 ? "completed" : "error"
      await record(job)
      publish(job)
    }, async cause => {
      if (job.settlement?.kind === "incomplete" || job.cleanupDetail !== undefined) {
        job.status = "running"
        if (job.settlement?.kind === "incomplete") job.cleanupDetail = job.settlement.phase + ": " + job.settlement.detail
      } else {
        job.failure = cause instanceof Error ? cause.message : String(cause)
        job.status = "error"
      }
      await record(job)
      publish(job)
    })
    return nativeJob
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
      job.cleanupDetail = settlement.phase + ": " + settlement.detail
      throw new Error("Execution owner retired an incomplete settlement")
    }
    job.cleanupDetail = undefined
    return true
  }

  return {
    run: run as NativeExecService["run"],
    async runBackground(command) { const capture = await makeCapture(command, undefined, true); const nativeJob = registerJob(capture); return { jobId: nativeJob.jobId, nativeJob } },
    getJobView(jobId) {
      const job = jobs.get(jobId)
      if (!job || !canAccess(job.owner)) throw new Error("unknown job: " + jobId)
      return view(job)
    },
    listJobViews() { return [...jobs.values()].filter(job => canAccess(job.owner)).map(view) },
    getOutput(jobId) {
      const job = jobs.get(jobId)
      if (!job || !canAccess(job.owner)) throw new Error("unknown job: " + jobId)
      // A genuine reader inside its own prepared call registers the same
      // original source here; outside one this remains a passive retry.
      if (job.status !== "running") void observe(job.capture)
      return view(job)
    },
    subscribeJob(jobId, listener) {
      const job = jobs.get(jobId)
      if (!job || !canAccess(job.owner)) throw new Error("unknown job: " + jobId)
      job.listeners.add(listener)
      return () => { job.listeners.delete(listener) }
    },
    listJobs() {
      return [...jobs.values()].filter(job => canAccess(job.owner)).map(job => { if (job.status !== "running") void observe(job.capture); return view(job) })
    },
    async killJob(jobId) {
      const job = jobs.get(jobId)
      if (!job || !canAccess(job.owner)) throw new Error("unknown job: " + jobId)
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
        job.cleanupDetail = settlement.phase + ": " + settlement.detail
        publish(job)
        throw new Error("Execution cancellation incomplete: " + settlement.detail)
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
      let unresolved: string[] = []
      try {
        await supervisor.dispose()
        // Close join: still-unknown settlements get one honest retry on their
        // original capture before the producer-side services are torn down.
        await Promise.allSettled([...jobs.values()].map(job => job.capture.complete))
        unresolved = await retention.drain()
        await host.dispose?.()
      } finally { for (const job of jobs.values()) job.listeners.clear() }
      if (unresolved.length) throw Object.assign(new Error("Result retention still requires recovery: " + unresolved.join(",")), { code: "ARTIFACT_RECOVERY_REQUIRED" })
    },
  }
}
