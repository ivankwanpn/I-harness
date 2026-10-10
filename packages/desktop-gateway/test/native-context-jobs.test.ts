import { afterEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createCodeRetrievalService, createCodeRetrievalTools, type CodeSnapshotReader } from '@i-harness/code-retrieval'
import { createSessionAssembly, type SessionAssembly } from '@i-harness/session-executor'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createNativeCodeSourceReader } from '../src/context-source-reader.ts'
import { createSessionManagement } from '../src/session-management.ts'
import { createConversationVisibility } from '../src/session-visibility.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation() })
async function fixture(durable = false) {
  const base = resolve('build/native-context-jobs-tests'); await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'fixture-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'repo'); await mkdir(workspace)
  await writeFile(join(workspace, 'main.ts'), 'export const searchable = true\n')
  const assemblies = new Map<string, SessionAssembly>()
  const coordinator = durable ? createSessionCoordinator(createJsonlBackend(join(root, 'sessions'))) : undefined
  if (coordinator) cleanup.push(() => coordinator.close())
  const reader: CodeSnapshotReader = createNativeCodeSourceReader({ workspace, references: () => [], authorize: async () => true })
  const service = createCodeRetrievalService({ root: join(root, 'storage'), workspaceId: 'workspace', reader, config: { enabled: true },
    registerJob: (access, job) => assemblies.get(access.sessionId)!.registerBackgroundJob!({ id: job.jobId, kind: 'code-context', label: 'Index sources', cancel: job.cancel }),
  })
  cleanup.push(() => service.close())
  for (const sessionId of ['s', 'other']) {
    if (coordinator) await coordinator.create({ sessionId })
    const assembly = await createSessionAssembly({ workspace, sessionId, modelPolicy: 'test-mock', sandbox: 'read-only', approveAll: true, additionalTools: createCodeRetrievalTools(service), ...(coordinator ? { coordinator, jobStatusEvents: true } : {}) })
    assemblies.set(sessionId, assembly); cleanup.push(() => assembly.dispose())
  }
  const assembly = assemblies.get('s')!
  const execute = async (name: string, args = {}, owner = assembly) => {
    const prepared = await owner.tools.prepare({ name, args }, undefined, { sessionId: owner.sessionId, callId: `fixture-${name}` })
    return owner.tools.dispatch(prepared) as Promise<any>
  }
  return { service, reader, assembly, other: assemblies.get('other')!, execute, coordinator }
}

it('makes an index job visible, cancels actual indexing, and preserves the committed index', async () => {
  const { service, reader, assembly, other, execute } = await fixture()
  const first = await execute('code_context_index')
  await service.wait(first.jobId)
  expect((await execute('job_list')).jobs).toContainEqual(expect.objectContaining({ id: first.jobId, kind: 'code-context', status: 'completed' }))
  expect(await execute('job_output', { job_id: first.jobId })).toMatchObject({ status: 'completed', text: expect.stringContaining('completed') })
  const snapshots = reader.snapshots.bind(reader)
  let entered!: () => void, release!: () => void, signal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  reader.snapshots = async function* (access, input) { signal = access.signal; entered(); await gate; yield* snapshots(access, input) }
  const pending = await execute('code_context_index')
  await started
  try {
    expect((await execute('job_list')).jobs).toContainEqual(expect.objectContaining({ id: pending.jobId, kind: 'code-context', status: 'running' }))
    expect(await execute('code_context_index', {}, other)).toEqual({ jobId: pending.jobId })
    expect((await execute('job_list', {}, other)).jobs).toContainEqual(expect.objectContaining({ id: pending.jobId, status: 'running' }))
    expect(await execute('job_kill', { job_id: pending.jobId }, other)).toEqual({ outcome: 'cancellation-requested' })
    expect(signal?.aborted).toBe(true)
  } finally { release() }
  expect(await service.wait(pending.jobId)).toMatchObject({ generation: 1, files: 1, lastJob: { outcome: 'cancelled' } })
  expect((await execute('job_list')).jobs).toContainEqual(expect.objectContaining({ id: pending.jobId, status: 'killed' }))
  const finalOutput = await execute('job_output', { job_id: pending.jobId })
  expect(finalOutput.text).toContain('"outcome":"cancelled"')
  expect(finalOutput.text).toContain('"generation":1')
  const cancellationOwnerOutput = await execute('job_output', { job_id: pending.jobId }, other)
  expect(cancellationOwnerOutput.text).toContain('"outcome":"cancelled"')
  expect(cancellationOwnerOutput.text).toContain('"generation":1')
  expect(await execute('job_kill', { job_id: pending.jobId })).toEqual({ outcome: 'already-finished' })
  expect((await service.search({ sessionId: 's' }, { query: 'searchable' })).hits).toHaveLength(1)
  expect(assembly.tasks().some(task => task.id === pending.jobId)).toBe(true)
}, 15000)

it('cancels and drains an index job before disposing its owning assembly', async () => {
  const { service, reader, assembly, execute } = await fixture()
  const snapshots = reader.snapshots.bind(reader)
  let entered!: () => void, release!: () => void, signal: AbortSignal | undefined
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  reader.snapshots = async function* (access, input) { signal = access.signal; entered(); await gate; yield* snapshots(access, input) }
  const { jobId } = await execute('code_context_index'); await started
  let disposed = false
  const disposing = assembly.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  const aborted = signal?.aborted, earlyDisposed = disposed
  release(); await disposing
  expect(aborted).toBe(true); expect(earlyDisposed).toBe(false)
  expect(await service.wait(jobId)).toMatchObject({ generation: 0, lastJob: { outcome: 'cancelled' } })
}, 15000)

it('records index failure in the shared job output', async () => {
  const { service, execute } = await fixture()
  await service.configure({ maxDiskBytes: 1 })
  const { jobId } = await execute('code_context_index')
  expect(await service.wait(jobId)).toMatchObject({ lastJob: { outcome: 'failed' } })
  expect(await execute('job_output', { job_id: jobId })).toMatchObject({ status: 'error', text: expect.stringContaining('quota') })
}, 15000)

it('rejects conflicting live producers that claim the same shared job ID', async () => {
  const { assembly, execute } = await fixture()
  const original = new AbortController(), conflicting = new AbortController()
  const handle = assembly.registerBackgroundJob!({ id: 'code-context-collision', kind: 'code-context', label: 'Original index', cancel: () => original.abort() })
  try {
    expect(() => assembly.registerBackgroundJob!({ id: 'code-context-collision', kind: 'code-context', label: 'Other index', cancel: () => conflicting.abort() })).toThrow(/duplicate job/i)
    expect(await execute('job_kill', { job_id: 'code-context-collision' })).toEqual({ outcome: 'cancellation-requested' })
    expect(original.signal.aborted).toBe(true); expect(conflicting.signal.aborted).toBe(false)
  } finally { handle.finish('killed', 'Fixture finished') }
})

it('refuses archival after cancellation until the actual index producer has drained', async () => {
  const { service, reader, assembly, execute, coordinator } = await fixture(true)
  const snapshots = reader.snapshots.bind(reader)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  reader.snapshots = async function* (access, input) { entered(); await gate; yield* snapshots(access, input) }
  const { jobId } = await execute('code_context_index'); await started
  const manager = createSessionManagement(coordinator!, {
    queueState: () => ({ running: false, queued: 0 }), tasks: () => assembly.tasks(), liveAssembly: () => assembly,
  } as any, createConversationVisibility(coordinator!))
  try {
    expect(await execute('job_kill', { job_id: jobId })).toEqual({ outcome: 'cancellation-requested' })
    expect((await execute('job_list')).jobs).toContainEqual(expect.objectContaining({ id: jobId, status: 'killed' }))
    await expect(manager.mutate('s', 'archive')).rejects.toThrow(/active|busy|drain/i)
    expect((await coordinator!.profile('s')).meta.archived).not.toBe(true)
  } finally { release(); await service.wait(jobId) }
  await manager.mutate('s', 'archive')
  expect((await coordinator!.profile('s')).meta.archived).toBe(true)
}, 15000)
