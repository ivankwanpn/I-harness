import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createExecutionLease, type TransportExecutionBackend } from '@i-harness/sandbox'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import { createExecService } from '../src/index.ts'

vi.mock('node:crypto', async original => {
  const actual = await original<typeof import('node:crypto')>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})
afterEach(() => vi.mocked(randomUUID).mockRestore())

// Actual service/supervisor/admission/capture. Each committed transport has its
// own distinct native receipt and independently controlled root/IO lifetime.
function fixture(incompleteRelease = false) {
  let admit!: () => void, failNext = false, preparations = 0
  const admission = new Promise<void>(done => { admit = done })
  const executions: Array<{ finish(): void; cancellations: number; releases: number }> = []
  const backend: TransportExecutionBackend = {
    async probe() { return { id: 'reservation', availability: 'available', assurance: 'unverified', features: { writeIsolation: false, readIsolation: false, denyPaths: false, pipes: true, pty: false, retainedTree: true } } },
    async prepare(spec, policy) {
      preparations++
      await admission
      if (failNext) { failNext = false; throw new Error('controlled preparation failure') }
      return { policy, async rollback() {}, async commit(check) {
        check()
        let finish!: () => void, drained!: () => void
        const rootGate = new Promise<void>(done => { finish = done }), ioDone = new Promise<void>(done => { drained = done })
        const control = { finish, cancellations: 0, releases: 0 }
        executions.push(control)
        const lease = createExecutionLease({ receipt: { executionId: `native-${executions.length}`, backendId: 'reservation', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' },
          rootExited: rootGate.then(() => ({ exitCode: 0 })), waitTreeEmpty: () => rootGate, settleIo: () => ioDone,
          releaseResources: async () => { control.releases++; if (incompleteRelease) throw new Error('controlled release incomplete') },
          terminate: async () => { control.cancellations++; finish() } })
        return { pid: 123 + executions.length, receipt: lease.receipt, rootExited: lease.rootExited, get settled() { return lease.settled }, cancel: lease.cancel, release: lease.release,
          io: { async write() {}, async endInput() {}, output: (async function* () { try { yield { channel: 'stdout' as const, data: Buffer.from('original') }; await rootGate } finally { drained() } })() } }
      } }
    },
  }
  const exec = createExecService({ execution: { defaultOwner: { sessionId: 'reservation-owner' }, selectBackend: () => backend, validateAuthority() {},
    resolvePolicy: owner => compileExecutionPolicy({ mode: 'danger-full-access', owner, authority: { kind: 'unbound', revision: 'reservation', workspaceRoot: resolve('.') } }) } })
  return { exec, admit, executions, preparations: () => preparations, failNext() { failNext = true }, allowRelease() { incompleteRelease = false } }
}

const token = '12345678-1234-4123-8123-123456789abc' as ReturnType<typeof randomUUID>

it.each(['background', 'promotion'] as const)('reserves overlapping equal UUIDs before %s can launch an unaddressable loser', async mode => {
  const f = fixture()
  vi.mocked(randomUUID).mockReturnValue(token)
  const launch = () => mode === 'background' ? f.exec.runBackground({ argv: ['controlled'] }) : f.exec.run({ argv: ['controlled'] }, { backgroundAfterMs: 0 })
  const results = Promise.allSettled([launch(), launch()])
  try {
    // Both calls are in flight before either capture can return/register.
    await new Promise<void>(done => setImmediate(done))
    f.admit()
    const outcomes = await results
    expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { message: 'Native job instance collision' } })
    expect(f.preparations(), 'Losing duplicate must never enter native admission').toBe(1)
    expect(f.executions).toHaveLength(1)
    const jobs = f.exec.listJobViews()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.nativeJob.instanceId).toBe(token)
    expect(jobs[0]!.status).toBe('running')
    expect(f.executions[0]!.cancellations).toBe(0)
    await expect(f.exec.killJob(jobs[0]!.id)).resolves.toBe('cancellation-requested')
    expect(f.executions[0]).toMatchObject({ cancellations: 1, releases: 1 })
    await f.exec.dispose()
    expect(f.executions[0]).toMatchObject({ cancellations: 1, releases: 1 })
  } finally { f.admit(); for (const execution of f.executions) execution.finish(); await f.exec.dispose() }
})

it('allows overlapping different UUIDs with distinct native receipts and independent cancellation', async () => {
  const f = fixture()
  const pending = Promise.all([f.exec.runBackground({ argv: ['first'] }), f.exec.runBackground({ argv: ['second'] })])
  try {
    f.admit()
    const [first, second] = await pending
    expect(first.nativeJob.instanceId).not.toBe(second.nativeJob.instanceId)
    expect(f.exec.getJobView(first.jobId).receipt!.executionId).not.toBe(f.exec.getJobView(second.jobId).receipt!.executionId)
    await f.exec.killJob(first.jobId)
    expect(f.exec.getJobView(second.jobId).status).toBe('running')
    expect(f.executions[1]!.cancellations).toBe(0)
    await f.exec.killJob(second.jobId)
  } finally { f.admit(); for (const execution of f.executions) execution.finish(); await f.exec.dispose() }
})

it('releases a failed-launch reservation so a subsequent genuine allocation can use that value', async () => {
  const f = fixture()
  vi.mocked(randomUUID).mockReturnValue(token)
  try {
    f.failNext(); f.admit()
    await expect(f.exec.runBackground({ argv: ['failure'] })).rejects.toThrow('controlled preparation failure')
    const submitted = await f.exec.runBackground({ argv: ['success'] })
    expect(submitted.nativeJob.instanceId).toBe(token)
    expect(f.executions).toHaveLength(1)
    await f.exec.killJob(submitted.jobId)
  } finally { f.admit(); for (const execution of f.executions) execution.finish(); await f.exec.dispose() }
})

it.each([false, true])('releases completed unpromoted foreground reservation (promotion eligible: %s)', async eligible => {
  const f = fixture()
  vi.mocked(randomUUID).mockReturnValue(token)
  const foreground = eligible ? f.exec.run({ argv: ['foreground'] }, { backgroundAfterMs: 60000 }) : f.exec.run({ argv: ['foreground'] })
  try {
    f.admit()
    await vi.waitFor(() => expect(f.executions).toHaveLength(1))
    f.executions[0]!.finish()
    expect(await foreground).toMatchObject({ stdout: 'original', exitCode: 0 })
    expect(f.exec.listJobViews()).toEqual([])
    const submitted = await f.exec.runBackground({ argv: ['later'] })
    expect(submitted.nativeJob.instanceId).toBe(token)
    expect(f.executions).toHaveLength(2)
    await f.exec.killJob(submitted.jobId)
  } finally { f.admit(); for (const execution of f.executions) execution.finish(); await f.exec.dispose() }
})

it('disposal settles an unpromoted capture once and does not replay native cleanup', async () => {
  const f = fixture()
  const foreground = f.exec.run({ argv: ['foreground'] })
  f.admit()
  try {
    await vi.waitFor(() => expect(f.executions).toHaveLength(1))
    await f.exec.dispose()
    await foreground
    await f.exec.dispose()
    expect(f.executions[0]).toMatchObject({ cancellations: 1, releases: 1 })
    expect(f.exec.listJobViews()).toEqual([])
  } finally { for (const execution of f.executions) execution.finish(); await f.exec.dispose() }
})

it('releases a rejected foreground observation only after its original native cleanup settles', async () => {
  const f = fixture()
  vi.mocked(randomUUID).mockReturnValue(token)
  const foreground = f.exec.run({ argv: ['foreground'] }, { stream: { maxBytes: 128, onStdout() { throw new Error('controlled observer failure') } } })
  const outcome = Promise.allSettled([foreground])
  f.admit()
  try {
    expect(await outcome).toMatchObject([{ status: 'rejected', reason: { message: 'controlled observer failure' } }])
    await new Promise<void>(done => setImmediate(done))
    expect(f.executions[0]).toMatchObject({ cancellations: 1, releases: 1 })
    const submitted = await f.exec.runBackground({ argv: ['later'] })
    expect(submitted.nativeJob.instanceId).toBe(token)
    await f.exec.killJob(submitted.jobId)
  } finally { for (const execution of f.executions) execution.finish(); await f.exec.dispose() }
})

it('disposal fences an in-flight admission without publishing or launching a job', async () => {
  const f = fixture()
  const submitted = f.exec.runBackground({ argv: ['pending'] })
  const outcome = Promise.allSettled([submitted])
  try {
    await vi.waitFor(() => expect(f.preparations()).toBe(1))
    const close = f.exec.dispose()
    f.admit()
    await close
    expect(await outcome).toMatchObject([{ status: 'rejected' }])
    expect(f.executions).toEqual([])
    expect(f.exec.listJobViews()).toEqual([])
    await f.exec.dispose()
  } finally { f.admit(); await f.exec.dispose() }
})

it('retains unresolved foreground cleanup reservation until original disposal settles it', async () => {
  const f = fixture(true)
  vi.mocked(randomUUID).mockReturnValue(token)
  const foreground = f.exec.run({ argv: ['foreground'] })
  const outcome = Promise.allSettled([foreground])
  f.admit()
  try {
    await vi.waitFor(() => expect(f.executions).toHaveLength(1))
    f.executions[0]!.finish()
    expect(await outcome).toMatchObject([{ status: 'rejected', reason: { message: expect.stringContaining('controlled release incomplete') } }])
    await expect(f.exec.runBackground({ argv: ['collision'] })).rejects.toThrow('Native job instance collision')
    expect(f.preparations()).toBe(1)
    expect(f.executions[0]).toMatchObject({ cancellations: 0, releases: 2 })
    f.allowRelease()
    await f.exec.dispose()
    await f.exec.dispose()
    expect(f.executions[0]).toMatchObject({ cancellations: 0, releases: 3 })
  } finally { f.allowRelease(); for (const execution of f.executions) execution.finish(); await f.exec.dispose() }
})
