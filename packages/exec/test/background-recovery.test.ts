import { expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createExecService, type BackgroundJobView, type ExecFrameCapture, type ExecResultRetention } from '../src/index.ts'
import { createExecFrameCapture } from '../../output-retention/src/index.ts'

type Finish = { kind: 'artifact' } | { kind: 'unknown' } | { kind: 'refused' }

/** Real exec service + controlled transport + the real frame capture: only the
 * artifact sink and observer behaviour are controlled. */
async function runJob(control: { finishes: Finish[]; observeThrows?: number; onCollection?: (exec: ReturnType<typeof createExecService>) => void }) {
  let drain!: () => void, release!: () => void
  const drained = new Promise<void>(done => { drain = done }), gate = new Promise<void>(done => { release = done })
  let launches = 0, attempts = 0, observations = 0, settlements = 0, frameCapture!: ExecFrameCapture
  const backend: TransportExecutionBackend = {
    async probe() { return { id: 'recovery-source', availability: 'available', assurance: 'unverified', features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) { return { policy, async rollback() {}, async commit(check) {
      check(); launches++
      const lease = createExecutionLease({ receipt: { executionId: 'recovery-source-1', backendId: 'recovery-source', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' },
        rootExited: gate.then(() => ({ exitCode: 0 })), waitTreeEmpty: () => gate, settleIo: () => drained, releaseResources: async () => {}, terminate: async () => { release() } })
      return { pid: 123, receipt: lease.receipt, rootExited: lease.rootExited, get settled() { return lease.settled }, cancel: lease.cancel, release: lease.release,
        io: { async write() {}, async endInput() {}, output: (async function* () { try { yield { channel: 'stdout' as const, data: Buffer.from('original') }; await gate } finally { drain() } })() } }
    } } },
  }
  const hex = (byte: string) => byte.repeat(64)
  const exec = createExecService({ execution: { defaultOwner: { sessionId: 'recovery-owner' }, selectBackend: () => backend, validateAuthority() {},
    resolvePolicy: owner => compileExecutionPolicy({ mode: 'danger-full-access', owner, authority: { kind: 'unbound', revision: 'recovery', workspaceRoot: resolve('.') } }) },
    resultRetention: {
      begin({ sourceId }) { return frameCapture = createExecFrameCapture({ sourceId, openArtifact: async () => ({
        async write() {}, async reconcileWrite() { return 'ready' as const },
        async finish() { attempts++; const next = control.finishes[Math.min(attempts - 1, control.finishes.length - 1)]!;
          return next.kind === 'artifact' ? { kind: 'committed' as const, ref: { version: 1 as const, id: 'ctxv1_' + hex('a'), revision: hex('b'), codec: 'exec-frames-v1' as const, encodedBytes: 9, contentDigest: hex('c'), completeness: 'complete' as const } }
            : next.kind === 'unknown' ? { kind: 'recovery-required' as const, operationId: 'original' }
            : { kind: 'refused' as const, reason: 'storage-refused' as const, observedEncodedBytes: 0 } },
        async reconcile() { throw new Error('The capture itself owns finish retries') },
      }) }) },
      async settle(capture) { settlements++; return capture.settle() },
      async observe(capture) { observations++; if (control.observeThrows && observations <= control.observeThrows) throw new Error('observer storage failed'); return capture.settle() },
    } satisfies ExecResultRetention })
  control.onCollection?.(exec)
  const { jobId } = await exec.runBackground({ argv: ['controlled-recovery-source'] })
  const terminal = new Promise<BackgroundJobView>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('No terminal view')), 5000)
    const stop = exec.subscribeJob(jobId, view => { if (view.status !== 'running') { clearTimeout(timer); stop(); done(view) } })
  })
  release()
  const first = await terminal
  return { exec, first, jobId, release, counters: () => ({ launches, attempts, observations }), capture: () => frameCapture, settlements: () => settlements }
}

it('keeps an unknown settlement retriable through query/list/close on the original capture', async () => {
  const job = await runJob({ finishes: [{ kind: 'unknown' }, { kind: 'refused' }] })
  let disposed = false
  try {
    expect(job.first.retentionFailure).toBe('recovery-required')
    job.exec.getOutput(job.jobId); job.exec.listJobs()
    await new Promise<void>(done => setImmediate(done))
    await job.exec.dispose(); disposed = true
    const counters = job.counters()
    expect(counters.launches).toBe(1)
    // Query/list/close each re-entered the same original operation.
    expect(counters.attempts).toBeGreaterThanOrEqual(2)
    // The same original capture now reaches its known terminal disposition.
    const direct = await job.capture().settle()
    expect(direct.kind).toBe('ready')
    expect(direct.kind === 'ready' ? direct.dependency.retention.kind : undefined).toBe('unavailable')
  } finally { job.release(); if (!disposed) await job.exec.dispose().catch(() => {}) }
})

it('projects the controlled sink artifact disposition after retrying the original unknown capture', async () => {
  const job = await runJob({ finishes: [{ kind: 'unknown' }, { kind: 'artifact' }] })
  let disposed = false
  try {
    expect(job.first.retentionFailure).toBe('recovery-required')
    expect(job.first.retained).toBeUndefined()
    const view = job.exec.getOutput(job.jobId)
    await new Promise<void>(done => setImmediate(done))
    expect(job.counters().attempts).toBe(2)
    expect(view.status).toBe('completed')
    expect(job.exec.getOutput(job.jobId).retained).toMatchObject({ kind: 'exec-frames', retention: { kind: 'artifact', ref: { id: 'ctxv1_' + 'a'.repeat(64) } } })
    await job.exec.dispose(); disposed = true
  } finally { job.release(); if (!disposed) await job.exec.dispose().catch(() => {}) }
})

it('reports a still-unknown close join honestly instead of claiming settlement', async () => {
  const job = await runJob({ finishes: [{ kind: 'unknown' }] })
  let disposed = false
  try {
    expect(job.first.retentionFailure).toBe('recovery-required')
    await expect(job.exec.dispose()).rejects.toMatchObject({ code: 'ARTIFACT_RECOVERY_REQUIRED' })
    disposed = true
    // One process launch for the whole control; nothing replayed.
    expect(job.counters().launches).toBe(1)
  } finally { job.release(); if (!disposed) await job.exec.dispose().catch(() => {}) }
})

it('keeps passive storage intact when a current observer fails and allows the next observation', async () => {
  const job = await runJob({ finishes: [{ kind: 'artifact' }], observeThrows: 1 })
  let disposed = false
  try {
    expect(job.first.retained).toMatchObject({ retention: { kind: 'artifact' } })
    expect(job.first.retentionFailure).toBeUndefined()
    expect(job.counters().observations).toBe(0)
    const denied = job.exec.getOutput(job.jobId)
    await new Promise<void>(done => setImmediate(done))
    expect(denied.retained).toEqual(job.first.retained)
    expect(denied.retentionFailure).toBeUndefined()
    const later = job.exec.getOutput(job.jobId)
    await new Promise<void>(done => setImmediate(done))
    expect(later.retained).toEqual(job.first.retained)
    expect(later.retentionFailure).toBeUndefined()
    expect(job.counters()).toEqual({ launches: 1, attempts: 1, observations: 2 })
    await job.exec.dispose(); disposed = true
  } finally { job.release(); if (!disposed) await job.exec.dispose().catch(() => {}) }
})

it('passive job metadata neither retries unknown storage nor registers an observer', async () => {
  const job = await runJob({ finishes: [{ kind: 'unknown' }, { kind: 'artifact' }] })
  try {
    expect(job.counters()).toEqual({ launches: 1, attempts: 1, observations: 0 })
    const first = job.exec.getJobView(job.jobId)
    expect(first.nativeJob).toBe(job.exec.listJobViews()[0]!.nativeJob)
    expect(first.retentionFailure).toBe('recovery-required')
    expect(first.retained).toBeUndefined()
    await new Promise<void>(done => setImmediate(done))
    expect(job.counters()).toEqual({ launches: 1, attempts: 1, observations: 0 })
    // Existing observing semantics still retry the exact original capture.
    job.exec.listJobs()
    await new Promise<void>(done => setImmediate(done))
    expect(job.counters()).toEqual({ launches: 1, attempts: 2, observations: 1 })
    expect(job.exec.getJobView(job.jobId).retained?.sourceId).toBe(first.nativeJob.sourceId)
  } finally { job.release(); await job.exec.dispose() }
})

it('publishes a newly registered job to collection observers', async () => {
  const counts: number[] = []
  const job = await runJob({ finishes: [{ kind: 'refused' }], onCollection: exec => {
    exec.subscribeJobs!(() => { throw Error('first consumer fails') })
    exec.subscribeJobs!(() => counts.push(exec.listJobViews!().length))
  } })
  try { expect(counts[0]).toBe(1); expect(counts.length).toBeGreaterThan(1); const before = counts.length; await job.exec.dispose(); expect(counts).toHaveLength(before + 1) }
  finally { await job.exec.dispose() }
})

it('notifies only the actual passive recovery disposition after ordinary terminal publications drain', async () => {
  const job = await runJob({ finishes: [{ kind: 'unknown' }, { kind: 'artifact' }] })
  const seen: BackgroundJobView[] = []
  let off = () => {}
  try {
    await new Promise<void>(done => setImmediate(done)); await new Promise<void>(done => setImmediate(done))
    const original = job.exec.getJobView(job.jobId).nativeJob
    job.exec.subscribeJobs!(() => { throw Error('isolated first consumer') })
    off = job.exec.subscribeJobs!(() => seen.push(job.exec.getJobView(job.jobId)))
    const before = { ...job.counters(), settlements: job.settlements() }
    job.exec.getJobView(job.jobId); job.exec.listJobViews()
    await new Promise<void>(done => setImmediate(done))
    expect(seen).toEqual([]); expect({ ...job.counters(), settlements: job.settlements() }).toEqual(before)
    job.exec.getOutput(job.jobId)
    await new Promise<void>(done => setImmediate(done))
    expect(seen).toHaveLength(1)
    expect(seen[0]!.nativeJob).toBe(original)
    expect(seen[0]!.retained).toMatchObject({ sourceId: original.sourceId, retention: { kind: 'artifact' } })
    expect(seen[0]!.retentionFailure).toBeUndefined()
    expect(job.counters()).toEqual({ launches: 1, attempts: 2, observations: 1 })
    job.exec.getOutput(job.jobId)
    await new Promise<void>(done => setImmediate(done))
    expect(seen).toHaveLength(1)
    off(); await job.exec.dispose(); expect(seen).toHaveLength(1)
  } finally { off(); await job.exec.dispose() }
})

it('keeps settled collection subscriptions passive for ten virtual minutes before and after unsubscribe', async () => {
  const job = await runJob({ finishes: [{ kind: 'artifact' }] })
  await new Promise<void>(done => setImmediate(done))
  let calls = 0
  const off = job.exec.subscribeJobs!(() => { calls++ })
  const reads = ['getOutput', 'listJobs', 'getJobView', 'listJobViews'].map(name => vi.spyOn(job.exec, name as 'getOutput'))
  const before = { ...job.counters(), settlements: job.settlements() }
  vi.useFakeTimers()
  try {
    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls).toBe(0); expect({ ...job.counters(), settlements: job.settlements() }).toEqual(before)
    reads.forEach(read => expect(read).not.toHaveBeenCalled())
    off(); await vi.advanceTimersByTimeAsync(600_000)
    expect(calls).toBe(0); expect({ ...job.counters(), settlements: job.settlements() }).toEqual(before)
    reads.forEach(read => expect(read).not.toHaveBeenCalled())
  } finally { vi.useRealTimers(); reads.forEach(read => read.mockRestore()); off(); await job.exec.dispose() }
})
