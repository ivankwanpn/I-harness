import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createExecService, withExecCallerScope } from '../src/index.ts'

vi.mock('node:crypto', async original => {
  const actual = await original<typeof import('node:crypto')>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})
afterEach(() => vi.mocked(randomUUID).mockRestore())

// Keep the genuine service, supervisor, admission and capture. Only the native
// transport is controlled so restart and promotion are causal and deterministic.
function service(fail = false, onPrepare = () => {}) {
  let release!: () => void, drained!: () => void
  const gate = new Promise<void>(done => { release = done })
  const ioDone = new Promise<void>(done => { drained = done })
  const backend: TransportExecutionBackend = {
    async probe() { return { id: 'controlled', availability: 'available', assurance: 'unverified', features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) {
      onPrepare()
      if (fail) throw new Error('controlled spawn failure')
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
  const exec = createExecService({ execution: { defaultOwner: { sessionId: 'same-owner' }, selectBackend: () => backend, validateAuthority() {},
    resolvePolicy: owner => compileExecutionPolicy({ mode: 'danger-full-access', owner, authority: { kind: 'unbound', revision: 'j1', workspaceRoot: resolve('.') } }) } })
  return { exec, release }
}

it('distinguishes sequential service/supervisor lifetimes despite repeated job and process ids and equal bytes', async () => {
  const identities = []
  for (let n = 0; n < 2; n++) {
    const f = service()
    try {
      const submitted = await f.exec.runBackground({ argv: ['controlled'] })
      f.release()
      await new Promise<void>(done => setImmediate(done))
      const view = f.exec.getOutput(submitted.jobId)
      expect(view.stdout).toBe('same bytes')
      expect(view.nativeJob).toMatchObject({ version: 1, jobId: 'bash-1', ownerSessionId: 'same-owner', sourceId: 'process:execution-1' })
      expect(view.nativeJob).toBe(submitted.nativeJob)
      expect(Object.isFrozen(view.nativeJob)).toBe(true)
      expect(view.nativeJob!.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(f.exec.getOutput(submitted.jobId).nativeJob).toBe(view.nativeJob)
      expect(f.exec.listJobs()[0]!.nativeJob).toBe(view.nativeJob)
      expect(() => withExecCallerScope({ sessionId: 'foreign' }, () => f.exec.getOutput(submitted.jobId))).toThrow('unknown job')
      identities.push(view.nativeJob)
    } finally { f.release(); await f.exec.dispose() }
  }
  expect(identities[0]!.instanceId).not.toBe(identities[1]!.instanceId)
})

it('allocates before native preparation and promotes the same foreground capture without minting on reads', async () => {
  let prelaunch: string | undefined
  const f = service(false, () => { prelaunch = vi.mocked(randomUUID).mock.results.at(-1)?.value })
  try {
    const promoted = await f.exec.run({ argv: ['controlled'] }, { backgroundAfterMs: 0 })
    expect(promoted).toHaveProperty('promoted', true)
    if (!('promoted' in promoted)) throw new Error('expected promotion')
    expect(promoted.nativeJob?.instanceId).toBe(prelaunch)
    expect(prelaunch).toBeTypeOf('string')
    const count = vi.mocked(randomUUID).mock.calls.length
    expect(f.exec.getOutput(promoted.jobId).nativeJob).toBe(promoted.nativeJob)
    f.exec.listJobs(); f.exec.getOutput(promoted.jobId)
    expect(vi.mocked(randomUUID).mock.calls.length).toBe(count)
  } finally { f.release(); await f.exec.dispose() }
})

it('publishes no background job when launch fails or admission is already canceled', async () => {
  const f = service(true)
  try {
    await expect(f.exec.runBackground({ argv: ['controlled'] })).rejects.toThrow('controlled spawn failure')
    expect(f.exec.listJobs()).toEqual([])
    const controller = new AbortController(); controller.abort()
    await expect(f.exec.runBackground({ argv: ['controlled'], abortSignal: controller.signal })).rejects.toThrow()
    expect(f.exec.listJobs()).toEqual([])
  } finally { f.release(); await f.exec.dispose() }
})

it('fails a duplicate original instance before publishing another job', async () => {
  const f = service()
  try {
    const first = await f.exec.runBackground({ argv: ['controlled'] })
    vi.mocked(randomUUID).mockReturnValueOnce(first.nativeJob.instanceId as ReturnType<typeof randomUUID>)
    await expect(f.exec.runBackground({ argv: ['controlled'] })).rejects.toThrow('Native job instance collision')
    expect(f.exec.listJobViews().map(job => job.nativeJob)).toEqual([first.nativeJob])
  } finally { f.release(); await f.exec.dispose() }
})
