import type { ExecutionSettlement, StopReason } from "@i-harness/sandbox"
import { randomUUID } from 'node:crypto'
import type { ExecutionSupervisor } from "../execution-supervisor.ts"
import type { ExecExecutionHost, NativeExecService, ExecServiceOptions, NativeJobIdentity } from "../index.ts"
import type { Capture, CaptureAttempt } from "../capture/contracts.ts"
import type { Job } from "./contracts.ts"
import { createCaptureFactory } from "../capture/output.ts"
import { createTransportLaunch } from "../transport-launch.ts"
import { createJobObservation } from "./observation.ts"
import { view } from "./views.ts"
import { createJobRetention } from './retention.ts'

/** Detach one reader without canceling original settlement or another reader. */
function joinReader<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, cause => { signal.removeEventListener('abort', abort); reject(cause) })
    if (signal.aborted) abort()
  })
}

/** The sole job registry, ID allocator and service disposal owner. */
export function createJobService(options: ExecServiceOptions, host: ExecExecutionHost, supervisor: ExecutionSupervisor): NativeExecService { return createJobServiceWithReservation(options, host, supervisor).service }
export function createJobServiceWithReservation(options: ExecServiceOptions, host: ExecExecutionHost, supervisor: ExecutionSupervisor) {
  const jobs = new Map<string, Job>()
  const collection = new Set<() => void>()
  function publishCollection() { for (const listener of [...collection]) { try { listener() } catch {} } }
  const captureJobs = new WeakMap<Capture, Job>()
  const captureInstances = new WeakMap<Capture, string>()
  // Only pending/captured ownership lives here. Publication transfers the token
  // to the existing job registry; terminal foreground observations release it.
  type Reservation = { instanceId: string; state: 'reserved' | 'started' | 'released'; attempt?: CaptureAttempt; delivery?: import('../direct-delivery.ts').OriginalExecDeliveryOwner }
  const captureDeliveries = new WeakMap<Capture, import('../direct-delivery.ts').OriginalExecDeliveryOwner>()
  const pendingInstances = new Map<string, Reservation>()
  const captureAttempts = new WeakMap<Capture, CaptureAttempt>()
  let nextJob = 0
  let disposed = false
  let disposal: Promise<void> | undefined
  let hostDisposed = false

  const { launchTransport, canAccess } = createTransportLaunch(options, host, supervisor, () => disposed)
  const resultRetention = options.resultRetention
  const retention = createJobRetention(resultRetention, capture => captureJobs.get(capture), publishCollection)
  const factory = createCaptureFactory(options, supervisor, launchTransport, retention, resultRetention)
  type MakeCapture = (command: import('../index.ts').ExecCommand, optionsForRun?: import('../index.ts').ExecStreamRunOptions, background?: boolean, promotable?: boolean) => Promise<Capture>
  const reservations = new WeakMap<object, Reservation>()
  function reserve(): object {
    if (disposed) throw new Error('Exec service disposed')
    const instanceId = randomUUID()
    if (pendingInstances.has(instanceId) || [...jobs.values()].some(job => job.instanceId === instanceId)) throw new Error('Native job instance collision')
    const entry: Reservation = { instanceId, state: 'reserved' }
    pendingInstances.set(instanceId, entry)
    const handle = Object.freeze({})
    reservations.set(handle, entry)
    return handle
  }
  function consume(handle: object) {
    const entry = reservations.get(handle)
    if (!entry || entry.state !== 'reserved' || disposed) throw new Error('Original reservation unavailable')
    entry.state = 'started'
    return entry
  }
  function release(handle: object) {
    const entry = reservations.get(handle)
    if (!entry || entry.state !== 'reserved') throw new Error('Original reservation unavailable')
    if (entry.delivery && !entry.delivery.isClean()) throw new Error('Original Exec delivery requires recovery')
    entry.state = 'released'; pendingInstances.delete(entry.instanceId)
  }
  async function captureReserved(entry: Reservation, ...args: Parameters<MakeCapture>) {
    let captured = false
    try {
      const attempt = factory.prepare(args[0],args[1],args[2],args[3],entry.delivery)
      entry.attempt = attempt
      entry.delivery?.prepareAttempt(attempt,retention.settleFrames,()=>{
        if(pendingInstances.get(entry.instanceId)===entry&&entry.attempt?.isClean()&&entry.delivery?.isClean())pendingInstances.delete(entry.instanceId)
      })
      const capture = await attempt.start()
      captured = true
      captureAttempts.set(capture, attempt)
      if (entry.delivery) {
        captureDeliveries.set(capture,entry.delivery)
        entry.delivery.bind(capture,attempt,retention.settleFrames)
      }
      if (disposed) throw new Error('Exec service disposed')
      captureInstances.set(capture, entry.instanceId)
      return retention.track(capture)
    } catch (error) {
      entry.delivery?.failed(entry.attempt)
      let cleanup: { cause: unknown } | undefined
      if (captured && entry.attempt) try { await entry.attempt.fail(error) } catch (cause) { cleanup = { cause } }
      if(entry.delivery&&entry.attempt?.isClean())try{await entry.delivery.close()}
      catch(cause){cleanup={cause:cleanup?new AggregateError([cleanup.cause,cause],'Capture and source cleanup failed'):cause}}
      if ((!entry.attempt || entry.attempt.isClean()) && (!entry.delivery || entry.delivery.isClean())) pendingInstances.delete(entry.instanceId)
      if (cleanup) throw new AggregateError([error, cleanup.cause], 'Capture publication and cleanup failed')
      throw error
    }
  }
  const makeCapture: MakeCapture = (...args) => captureReserved(consume(reserve()), ...args)
  const { observe, record } = retention

  const run = createJobObservation({ makeCapture, registerJob: publishJob, releaseCapture, isDisposed: () => disposed, observe })

  function releaseCapture(capture: Capture): void {
    if (captureJobs.has(capture)) return
    const instanceId = captureInstances.get(capture)
    const release = () => { if (instanceId && !captureJobs.has(capture) && (!captureDeliveries.get(capture) || captureDeliveries.get(capture)!.isClean())) pendingInstances.delete(instanceId) }
    if (captureAttempts.get(capture)?.isClean()) {
      const delivery=captureDeliveries.get(capture)
      if(delivery)void delivery.close().then(release,()=>{})
      else release()
      return
    }
    // Observation failures can precede native settlement. Keep their token
    // reserved until the exact original capture settles; incomplete cleanup
    // stays owned until successful service disposal.
    void capture.complete.catch(() => {}).then(async () => {
      const attempt = captureAttempts.get(capture)
      try { await attempt?.retryCleanup(); if (attempt?.isClean()) { await captureDeliveries.get(capture)?.close(); release() } }
      catch { /* The original attempt still owns native/output cleanup debt. */ }
    })
  }

  function cancelExecution(id: string, reason: StopReason): Promise<ExecutionSettlement> {
    const execution = supervisor.list().find(entry => entry.id === id)
    if (!execution || !canAccess(execution.policy.owner)) return Promise.reject(new Error("Unknown execution for caller"))
    return supervisor.cancel(id, reason)
  }

  function registerJob(capture: Capture): NativeJobIdentity {
    if (disposed) throw new Error('Exec service disposed')
    const existing = captureJobs.get(capture)
    if (existing) return existing.nativeJob
    const instanceId = captureInstances.get(capture)
    if (!instanceId || !pendingInstances.has(instanceId)) throw new Error('Missing original native job instance')
    if ([...jobs.values()].some(job => job.instanceId === instanceId)) throw new Error('Native job instance collision')
    const id = "bash-" + (++nextJob)
    // Read fallible native getters before publication transfers pending ownership.
    const nativeHandle = capture.execution.handle
    const rootExited = nativeHandle.rootExited, settled = nativeHandle.settled
    const nativeJob: NativeJobIdentity = Object.freeze({ version: 1, instanceId, jobId: id,
      ownerSessionId: capture.execution.policy.owner.sessionId, sourceId: `process:${capture.execution.id}` })
    const job: Job = { id, instanceId, nativeJob, capture, status: "running", owner: capture.execution.policy.owner, listeners: new Set() }
    jobs.set(id, job)
    captureJobs.set(capture, job)
    pendingInstances.delete(instanceId)
    publishCollection()
    void rootExited.then(root => { job.root = root; publish(job) }, cause => { job.failure = String(cause); publish(job) })
    void settled.then(settlement => {
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

  /** All publication callers share the exact original attempt's failure path. */
  async function publishJob(capture: Capture): Promise<NativeJobIdentity> {
    try { const identity=registerJob(capture); await captureDeliveries.get(capture)?.promoted(); return identity }
    catch (cause) {
      let cleanup: { cause: unknown } | undefined
      try { await captureAttempts.get(capture)?.fail(cause) }
      catch (failure) { cleanup = { cause: failure } }
      // releaseCapture removes only an attempt with proven clean ownership.
      releaseCapture(capture)
      if (cleanup) throw new AggregateError([cause, cleanup.cause], 'Execution publication and cleanup failed')
      throw cause
    }
  }

  function publish(job: Job): void {
    publishCollection()
    // Observers receive independent views and cannot interrupt owner transitions.
    for (const listener of [...job.listeners]) {
      try { listener(view(job)) } catch { /* The producer retains ownership. */ }
    }
  }

  async function settledAfterRetirement(job: Job, current: () => void = () => {}): Promise<boolean> {
    current()
    if (job.settlement?.kind === "settled") {
      job.cleanupDetail = undefined
      return true
    }
    // The supervisor removes entries only after the driver's full settlement.
    // Its observer can retire the entry before this job-view observer runs.
    if (supervisor.list().some(entry => entry.id === job.capture.execution.id)) return false
    const settlement = await job.capture.execution.handle.settled
    current()
    job.settlement = settlement
    if (settlement.kind !== "settled") {
      job.cleanupDetail = settlement.phase + ": " + settlement.detail
      throw new Error("Execution owner retired an incomplete settlement")
    }
    job.cleanupDetail = undefined
    return true
  }

  const service: NativeExecService = {
    supportsNativeJobKill: true,
    run: run as NativeExecService["run"],
    async runBackground(command) {
      const capture = await makeCapture(command, undefined, true)
      const nativeJob = await publishJob(capture)
      return { jobId: nativeJob.jobId, nativeJob }
    },
    getJobView(jobId) {
      const job = jobs.get(jobId)
      if (!job || disposed || !canAccess(job.owner)) throw new Error("unknown job: " + jobId)
      return view(job)
    },
    listJobViews() { return [...jobs.values()].filter(job => canAccess(job.owner)).map(view) },
    async observeJobOutput(jobId, { signal, jobInstanceId, sourceId } = {}) {
      const job = jobs.get(jobId)
      if (!job || disposed || !canAccess(job.owner)) throw new Error('unknown job: ' + jobId)
      if (jobInstanceId !== undefined && jobInstanceId !== job.instanceId) throw new Error('stale-instance')
      if (sourceId !== undefined && sourceId !== job.nativeJob.sourceId) throw new Error('stale-source')
      const instance = job.instanceId
      const current = () => {
        signal?.throwIfAborted()
        if (disposed || jobs.get(jobId) !== job || job.instanceId !== instance || !canAccess(job.owner)) throw new Error('Job observation no longer current or authorized')
      }
      current()
      const result = (source: import('../capture/frames.ts').ExecOutputSource) => { current(); return { view: view(job), nativeJob: job.nativeJob, source } }
      const owner = options.resultRetention, frames = job.capture.frames
      if (!owner || !frames) return result({ kind: 'unavailable', reason: 'retention-unsupported' })
      // Pending is metadata only: registering the unfinished capture here
      // would make this caller's finalizer require native EOF/recovery.
      if (job.status === 'running') return result({ kind: 'pending' })
      // Terminal observation begins inside the genuine caller before any
      // await or finalizer, with its rejection handled immediately.
      let observing: Promise<import('../capture/frames.ts').ExecFrameObservation>
      try { observing = Promise.resolve(owner.observe(frames)).catch(() => ({ kind: 'recovery-required' as const })) }
      catch { observing = Promise.resolve({ kind: 'recovery-required' }) }
      const observed = await joinReader(observing, signal)
      current()
      await joinReader(record(job), signal)
      current()
      if (observed.kind === 'recovery-required') return result(observed)
      if (observed.dependency.retention.kind === 'unavailable') return result({ kind: 'unavailable', reason: observed.dependency.retention.reason })
      if (!owner.summarize) return result({ kind: 'unavailable', reason: 'summary-unsupported' })
      try {
        const source = await joinReader(owner.summarize(frames, { signal }), signal)
        return result(source)
      } catch {
        current()
        return result({ kind: 'unavailable', reason: 'read-unavailable' })
      }
    },
    async readJobOutputFrames(jobId, query) {
      const { signal, jobInstanceId, sourceId, maxBytes, textView } = query, cursor = query.cursor ? { ...query.cursor } : undefined
      const job = jobs.get(jobId)
      if (!job || disposed || !canAccess(job.owner)) throw new Error('unknown job')
      if (jobInstanceId !== job.instanceId) throw new Error('stale-instance')
      if (sourceId !== undefined && sourceId !== job.nativeJob.sourceId) throw new Error('stale-source')
      const current = () => {
        signal?.throwIfAborted()
        if (disposed || jobs.get(jobId) !== job || job.instanceId !== jobInstanceId || !canAccess(job.owner)) throw new Error('Job frame read no longer current or authorized')
      }
      current()
      if (job.status === 'running') return { kind: 'unavailable', reason: 'output-pending' }
      const owner = options.resultRetention, frames = job.capture.frames
      if (!owner?.readFrames || !frames) return { kind: 'unavailable', reason: 'frame-read-unsupported' }
      try {
        const observed = await joinReader(owner.observe(frames), signal)
        current()
        await joinReader(record(job), signal)
        current()
        if (observed.kind !== 'ready') return observed
        if (observed.dependency.retention.kind === 'unavailable') return { kind: 'unavailable', reason: observed.dependency.retention.reason }
        const result = await joinReader(owner.readFrames(frames, { signal, cursor, maxBytes, textView }), signal)
        current()
        return result
      } catch (cause) { current(); throw cause }
    },
    getOutput(jobId) {
      const job = jobs.get(jobId)
      if (!job || disposed || !canAccess(job.owner)) throw new Error("unknown job: " + jobId)
      // A genuine reader inside its own prepared call registers the same
      // original source here; outside one this remains a passive retry.
      if (job.status !== "running") void observe(job.capture)
      return view(job)
    },
    subscribeJobs(listener) { if (disposed) throw new Error('Exec service disposed'); collection.add(listener); return () => { collection.delete(listener) } },
    subscribeJob(jobId, listener) {
      const job = jobs.get(jobId)
      if (!job || disposed || !canAccess(job.owner)) throw new Error("unknown job: " + jobId)
      job.listeners.add(listener)
      return () => { job.listeners.delete(listener) }
    },
    listJobs() {
      return [...jobs.values()].filter(job => canAccess(job.owner)).map(job => { if (job.status !== "running") void observe(job.capture); return view(job) })
    },
    async killJob(jobId, expected) {
      const job = jobs.get(jobId)
      if (!job || disposed || !canAccess(job.owner)) throw new Error("unknown job: " + jobId)
      const instanceId = job.instanceId, identity = job.nativeJob, capture = job.capture
      const jobInstanceId = expected?.jobInstanceId, sourceId = expected?.sourceId
      if (expected !== undefined && (!expected || typeof expected !== 'object' || Object.keys(expected).some(key => key !== 'jobInstanceId' && key !== 'sourceId') || typeof jobInstanceId !== 'string' || !jobInstanceId.trim() || (sourceId !== undefined && (typeof sourceId !== 'string' || !sourceId.trim())))) throw new Error('invalid-selector')
      const current = () => {
        if (disposed || jobs.get(jobId) !== job || job.instanceId !== instanceId || job.nativeJob !== identity || job.capture !== capture || !canAccess(job.owner)) throw new Error("unknown job: " + jobId)
        if (jobInstanceId !== undefined && jobInstanceId !== instanceId) throw new Error("stale-instance")
        if (sourceId !== undefined && sourceId !== job.nativeJob.sourceId) throw new Error("stale-source")
      }
      current()
      const retired = await settledAfterRetirement(job, current)
      current()
      if (retired) return "already-finished"
      if (job.status !== "running" && job.settlement?.kind !== "incomplete") return "already-finished"
      let settlement: ExecutionSettlement
      try { current(); settlement = await supervisor.cancel(capture.execution.id, "cancelled"); current() }
      catch (cause) {
        current()
        const retired = await settledAfterRetirement(job, current)
        current()
        if (retired) return "already-finished"
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
      await capture.complete.catch(() => {})
      current()
      job.root = settlement.root
      job.exitCode = settlement.root.exitCode ?? -1
      job.failure = undefined
      job.cleanupDetail = undefined
      job.status = "killed"
      publish(job)
      return "cancellation-requested"
    },
    launchTransport, cancelExecution,
    dispose() {
      disposed = true
      if (disposal) return disposal
      // Store before callbacks/host code can synchronously reenter dispose.
      const attempt = Promise.resolve().then(async () => {
        publishCollection(); collection.clear()
        const native = Promise.resolve().then(() => supervisor.dispose())
        for(const entry of pendingInstances.values())if(entry.state==='reserved')entry.delivery?.failed(undefined)
        const attempts = new Set([...pendingInstances.values()].flatMap(entry => entry.attempt ? [entry.attempt] : []))
        for (const job of jobs.values()) { const owner = captureAttempts.get(job.capture); if (owner) attempts.add(owner) }
        const outcomes = await Promise.allSettled([native, ...[...attempts].map(owner => owner.retire())])
        const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])
        const deliveries=new Set([...pendingInstances.values()].flatMap(entry=>entry.delivery?[entry.delivery]:[]))
        for(const job of jobs.values()){const delivery=captureDeliveries.get(job.capture);if(delivery)deliveries.add(delivery)}
        for(const result of await Promise.allSettled([...deliveries].map(owner=>owner.close())))if(result.status==='rejected')failures.push(result.reason)
        let unresolved: string[] = []
        try { unresolved = await retention.drain() } catch (cause) { failures.push(cause) }
        if (unresolved.length) failures.push(Object.assign(new Error('Result retention still requires recovery: ' + unresolved.join(',')), { code: 'ARTIFACT_RECOVERY_REQUIRED' }))
        for (const [id, entry] of pendingInstances) if ((entry.attempt?.isClean()||entry.state==='reserved'&&!entry.attempt) && (!entry.delivery || entry.delivery.isClean())) pendingInstances.delete(id)
        for (const job of jobs.values()) job.listeners.clear()
        if (failures.length) throw Object.assign(new AggregateError(failures,
          'Exec service disposal failed' + (unresolved.length ? ': Result retention still requires recovery: ' + unresolved.join(',') : '')),
          unresolved.length ? { code: 'ARTIFACT_RECOVERY_REQUIRED' } : {})
        if (!hostDisposed) { await host.dispose?.(); hostDisposed = true }
      })
      disposal = attempt
      void attempt.catch(() => { if (disposal === attempt) disposal = undefined })
      return attempt
    },
  }
  const port = Object.freeze({
    attachDelivery(handle: object, delivery: import('../direct-delivery.ts').OriginalExecDeliveryOwner) {
      if(this!==port)throw new Error('Invalid reservation port receiver')
      const entry=reservations.get(handle)
      if(!entry||entry.state!=='reserved'||entry.delivery||disposed)throw new Error('Original reservation unavailable')
      entry.delivery=delivery
    },
    async abortDelivery(handle: object) {
      if(this!==port)throw new Error('Invalid reservation port receiver')
      const entry=reservations.get(handle)
      if(!entry||entry.state!=='reserved')throw new Error('Original reservation unavailable')
      entry.delivery?.failed(undefined)
      await entry.delivery?.close()
      release(handle)
    },
    reserve() {
      if (this !== port) throw new Error('Invalid reservation port receiver')
      return reserve()
    },
    instanceId(handle: object) {
      if (this !== port) throw new Error('Invalid reservation port receiver')
      const entry = reservations.get(handle)
      if (!entry || entry.state !== 'reserved' || disposed) throw new Error('Original reservation unavailable')
      return entry.instanceId
    },
    release(handle: object) {
      if (this !== port) throw new Error('Invalid reservation port receiver')
      release(handle)
    },
    async start(handle: object, command: import('../index.ts').ExecCommand, mode: 'foreground' | 'background', runOptions?: import('../index.ts').ExecRunOptions) {
      if (this !== port) throw new Error('Invalid reservation port receiver')
      const entry = consume(handle)
      let captured = false
      const reservedCapture: MakeCapture = (...args) => { captured = true; return captureReserved(entry, ...args) }
      let failure: { cause: unknown } | undefined
      try {
        if (mode === 'background') {
          const capture = await reservedCapture(command, undefined, true)
          const nativeJob = await publishJob(capture)
          return { jobId: nativeJob.jobId, nativeJob }
        }
        if (mode !== 'foreground') throw new Error('Invalid reservation mode')
        return await createJobObservation({ makeCapture: reservedCapture, registerJob: publishJob, releaseCapture, isDisposed: () => disposed, observe })(command, runOptions)
      } catch (cause) { failure={cause};throw cause }
      finally {
        if(!captured&&entry.delivery){
          entry.delivery.failed(undefined)
          try{await entry.delivery.close()}
          catch(cleanup){throw new AggregateError(failure?[failure.cause,cleanup]:[cleanup],'Exec prelaunch delivery cleanup failed')}
        }
        if (!captured && (!entry.delivery || entry.delivery.isClean())) pendingInstances.delete(entry.instanceId)
      }
    },
  })
  return { service, port }
}
