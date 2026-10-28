import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createExecService, withExecCallerScope } from '../src/index.ts'

// Keep the genuine service, supervisor, admission and capture. Only the native
// transport is controlled so pending completion and observation faults are deterministic.
function service(resultRetention?: import('../src/index.ts').ExecResultRetention, access?: () => boolean) {
  let release!: () => void, drained!: () => void
  const gate = new Promise<void>(done => { release = done })
  const ioDone = new Promise<void>(done => { drained = done })
  const backend: TransportExecutionBackend = {
    async probe() { return { id: 'controlled', availability: 'available', assurance: 'unverified', features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) {


      return { policy, async rollback() {}, async commit(check) {
        check()
        const lease = createExecutionLease({ receipt: { executionId: 'native-1', backendId: 'controlled', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' },
          rootExited: gate.then(() => ({ exitCode: 0 })), waitTreeEmpty: () => gate, settleIo: () => ioDone,
          releaseResources: async () => {}, terminate: async () => { release() } })
        return { pid: 123, receipt: lease.receipt, rootExited: lease.rootExited, get settled() { return lease.settled }, cancel: lease.cancel, release: lease.release,
          io: { async write() {}, async endInput() {}, output: (async function* () { try { yield { channel: 'stdout' as const, data: Buffer.from('same bytes') }; await gate } finally { drained() } })() } }
      } }
    },
  }
  const exec = createExecService({ resultRetention, execution: { defaultOwner: { sessionId: 'same-owner' }, canAccessOwner: access, selectBackend: () => backend, validateAuthority() {},
    resolvePolicy: owner => compileExecutionPolicy({ mode: 'danger-full-access', owner, authority: { kind: 'unbound', revision: 'j1', workspaceRoot: resolve('.') } }) } })
  return { exec, release }
}

async function completed(f: ReturnType<typeof service>, jobId: string) {
  f.release()
  while (f.exec.getJobView(jobId).status === 'running') await new Promise<void>(done => setImmediate(done))
}

it('reports explicitly unavailable for the genuine native no-retention path', async () => {
  const f = service()
  try {
    const { jobId } = await f.exec.runBackground({ argv: ['controlled'] })
    expect((await f.exec.observeJobOutput(jobId)).source).toEqual({ kind: 'unavailable', reason: 'retention-unsupported' })
    const controller = new AbortController(); controller.abort(new Error('cancel observation'))
    await expect(f.exec.observeJobOutput(jobId, { signal: controller.signal })).rejects.toThrow('cancel observation')
    expect(f.exec.getJobView(jobId).status).toBe('running')
    await completed(f, jobId)
    expect((await f.exec.observeJobOutput(jobId)).view.status).toBe('completed')
    await expect(withExecCallerScope({ sessionId: 'foreign' }, () => f.exec.observeJobOutput(jobId))).rejects.toThrow('unknown job')
  } finally { f.release(); await f.exec.dispose() }
})

// Isolated callback/fault controls, not proof of retained bytes or ownership.
function adapter(kind: 'unavailable' | 'recovery-required' | 'summary-unsupported' = 'unavailable') {
  let done = false, observers = 0, block: Promise<void> | undefined
  const dependency = { kind: 'exec-frames' as const, sourceId: 'process:execution-1', retention: kind === 'summary-unsupported'
    ? { kind: 'artifact' as const, ref: { version: 1 as const, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1' as const, encodedBytes: 9, contentDigest: 'c'.repeat(64), completeness: 'complete' as const } }
    : { kind: 'unavailable' as const, reason: 'quota' as const } }
  const settle = async () => !done || kind === 'recovery-required' ? { kind: 'recovery-required' as const } : { kind: 'ready' as const, dependency }
  const capture = { sourceId: dependency.sourceId, async write() {}, complete() { done = true }, settle }
  return { owner: { begin: () => capture, settle, async observe() { observers++; await block; return settle() } },
    get observers() { return observers }, hold(promise: Promise<void>) { block = promise } }
}

it.each(['unavailable', 'recovery-required', 'summary-unsupported'] as const)('isolated callback %s leaves native status completed and starts terminal registration synchronously', async kind => {
  const a = adapter(kind), f = service(a.owner)
  try {
    const { jobId } = await f.exec.runBackground({ argv: ['controlled'] })
    const pending = f.exec.observeJobOutput(jobId)
    expect(a.observers).toBe(0)
    expect((await pending).source).toEqual({ kind: 'pending' })
    await completed(f, jobId)
    const observing = f.exec.observeJobOutput(jobId)
    expect(a.observers).toBe(1)
    const observation = await observing
    expect(observation.view.status).toBe('completed')
    expect(observation.source).toEqual(kind === 'recovery-required' ? { kind } : { kind: 'unavailable', reason: kind === 'unavailable' ? 'quota' : 'summary-unsupported' })
  } finally {
    f.release()
    if (kind === 'recovery-required') await expect(f.exec.dispose()).rejects.toThrow('Result retention still requires recovery')
    else await f.exec.dispose()
  }
})

it('isolated abort detaches one awaiting observer while a second observer and the original native job remain intact', async () => {
  const a = adapter(), f = service(a.owner)
  let release!: () => void
  try {
    const { jobId } = await f.exec.runBackground({ argv: ['controlled'] })
    await completed(f, jobId)
    a.hold(new Promise<void>(done => { release = done }))
    const controller = new AbortController()
    const cancelled = f.exec.observeJobOutput(jobId, { signal: controller.signal })
    const second = f.exec.observeJobOutput(jobId)
    controller.abort(new Error('only this observation'))
    await expect(cancelled).rejects.toThrow('only this observation')
    expect(f.exec.getJobView(jobId).status).toBe('completed')
    release()
    expect((await second).source).toEqual({ kind: 'unavailable', reason: 'quota' })
  } finally { release?.(); f.release(); await f.exec.dispose() }
})

it.each(['revoked', 'disposed'] as const)('isolated awaiting observation rejects %s currentness before returning output', async reason => {
  let authorized = true, release!: () => void
  const a = adapter(), f = service(a.owner, () => authorized)
  try {
    const { jobId } = await f.exec.runBackground({ argv: ['controlled'] })
    await completed(f, jobId)
    a.hold(new Promise<void>(done => { release = done }))
    const pending = withExecCallerScope({ sessionId: 'authorized-reader' }, () => f.exec.observeJobOutput(jobId))
    if (reason === 'revoked') authorized = false
    else await f.exec.dispose()
    release()
    await expect(pending).rejects.toThrow('no longer current or authorized')
  } finally { release?.(); f.release(); authorized = true; await f.exec.dispose() }
})
it('refuses stale native observation/frame selectors before original observer or frame reads', async () => {
  const a = adapter('summary-unsupported'), f = service(a.owner)
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['controlled'] })
    await completed(f, jobId)
    await expect(f.exec.observeJobOutput(jobId, { jobInstanceId: 'old' })).rejects.toThrow('stale-instance')
    await expect(f.exec.observeJobOutput(jobId, { sourceId: 'old' })).rejects.toThrow('stale-source')
    await expect(f.exec.readJobOutputFrames(jobId, { jobInstanceId: 'old' })).rejects.toThrow('stale-instance')
    expect(a.observers).toBe(0)
    expect(await f.exec.readJobOutputFrames(jobId, { jobInstanceId: nativeJob.instanceId })).toEqual({ kind: 'unavailable', reason: 'frame-read-unsupported' })
    expect(a.observers).toBe(0)
  } finally { f.release(); await f.exec.dispose() }
})
it('a frame reader abort detaches while another reader joins the same original settlement', async () => {
  const a = adapter('summary-unsupported'), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const dependency = { kind: 'exec-frames' as const, sourceId: 'process:execution-1', retention: { kind: 'artifact' as const, ref: { version: 1 as const, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1' as const, encodedBytes: 9, contentDigest: 'c'.repeat(64), completeness: 'complete' as const } } }
  const f = service({ ...a.owner, async readFrames() { entered.resolve(); await released.promise; return { kind: 'page', dependency, page: { ref: dependency.retention.ref, cursor: { recordOffset: 9, sliceOffset: 0 }, nextCursor: null, eof: true, frames: [] } } } })
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['controlled'] })
    await completed(f, jobId)
    const controller = new AbortController()
    const canceled = f.exec.readJobOutputFrames(jobId, { jobInstanceId: nativeJob.instanceId, signal: controller.signal })
    const surviving = f.exec.readJobOutputFrames(jobId, { jobInstanceId: nativeJob.instanceId })
    await entered.promise
    controller.abort(new Error('only this frame reader'))
    await expect(canceled).rejects.toThrow('only this frame reader')
    expect(f.exec.getJobView(jobId).status).toBe('completed')
    released.resolve()
    expect((await surviving).kind).toBe('page')
  } finally { released.resolve(); f.release(); await f.exec.dispose() }
})
it.each(['access', 'dispose'] as const)('refuses a saved frame page on %s loss during a rejected await', async mode => {
  const a = adapter('summary-unsupported'), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  let authorized = true
  const f = service({ ...a.owner, async readFrames() { entered.resolve(); await released.promise; throw new Error('ordinary read failure') } }, () => authorized)
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['controlled'] })
    await completed(f, jobId)
    const reading = withExecCallerScope({ sessionId: 'reader' }, () => f.exec.readJobOutputFrames(jobId, { jobInstanceId: nativeJob.instanceId }))
    await entered.promise
    if (mode === 'access') authorized = false
    else await f.exec.dispose()
    released.resolve()
    await expect(reading).rejects.toThrow('no longer current or authorized')
  } finally { authorized = true; released.resolve(); f.release(); await f.exec.dispose() }
})
it.each(['steer', 'abort'] as const)('genuine native job_output %s detaches its reader and leaves the selected original job running', async mode => {
  const { createJobOutputTool } = await import('../../subagent/src/tools/status.ts')
  const { createSession, Inbox } = await import('@i-harness/core-session')
  const f = service(), session = createSession(), controller = new AbortController()
  const tool = createJobOutputTool({ exec: f.exec, jobs: { read() { throw new Error('unknown job') } }, table: { entries: () => new Map() } } as any)
  try {
    const { jobId, nativeJob } = await f.exec.runBackground({ argv: ['controlled'] })
    const reading = tool.execute({ job_id: jobId, wait: true, timeout_ms: 1000 }, { session, abortSignal: controller.signal })
    if (mode === 'steer') {
      new Inbox(session).admit({ inputId: 'steer', text: 'refocus', intent: 'user', delivery: 'steer' })
      expect(await reading).toMatchObject({ native_job: nativeJob, status: 'running', yielded: true, yield_reason: 'user-steer', display_only: true })
    } else {
      controller.abort(new Error('only native observation'))
      await expect(reading).rejects.toThrow('only native observation')
    }
    expect(f.exec.getJobView(jobId)).toMatchObject({ nativeJob, status: 'running' })
    await completed(f, jobId)
    expect(await tool.execute({ job_id: jobId }, { session })).toMatchObject({ native_job: nativeJob, status: 'completed', display_only: true })
  } finally { f.release(); await f.exec.dispose() }
})
