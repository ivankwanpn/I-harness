import { it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ exec: undefined as any, workflow: undefined as any, attached: { exec: 0, workflow: 0 }, detached: { exec: 0, workflow: 0 }, launches: 0, controls: [] as { root: PromiseWithResolvers<{ exitCode: number }>; tree: PromiseWithResolvers<void> }[] }))
vi.mock('../../exec/src/index.ts', async original => {
  const actual = await original<any>()
  return { ...actual, registerExec(...args: any[]) {
    const service = actual.registerExec(...args), subscribe = service.subscribeJobs.bind(service)
    service.subscribeJobs = (listener: () => void) => { state.attached.exec++; const off = subscribe(listener); return () => { state.detached.exec++; off() } }
    state.exec = service; return service
  } }
})
vi.mock('../../workflow/src/index.ts', async original => {
  const actual = await original<any>()
  return { ...actual, registerWorkflow(...args: any[]) {
    const mount = actual.registerWorkflow(...args), subscribe = mount.executor.subscribeJobs.bind(mount.executor)
    mount.executor.subscribeJobs = (listener: () => void) => { state.attached.workflow++; const off = subscribe(listener); return () => { state.detached.workflow++; off() } }
    state.workflow = mount.executor; return mount
  } }
})
vi.mock('../../sandbox-local/src/index.ts', async original => {
  const actual = await original<any>(), { createExecutionLease } = await import('@i-harness/sandbox')
  return { ...actual, createLocalExecutionBackends() { return { select: () => ({
    async probe() { return { id: 'assembly-controlled', availability: 'available', assurance: 'unverified', features: { pipes: true, pty: false, retainedTree: true, writeIsolation: false, readIsolation: false, denyPaths: false } } },
    async prepare(spec: any, policy: any) { return { policy, async rollback() {}, async commit(check: () => void) {
      check(); state.launches++
      const root = Promise.withResolvers<{ exitCode: number }>(), tree = Promise.withResolvers<void>(), io = Promise.withResolvers<void>()
      state.controls.push({ root, tree })
      const lease = createExecutionLease({ receipt: { executionId: `source-${state.launches}`, backendId: 'assembly-controlled', policyFingerprint: policy.fingerprint, owner: spec.owner, assurance: 'unverified' }, rootExited: root.promise, waitTreeEmpty: () => tree.promise, settleIo: () => io.promise, releaseResources: async () => {}, terminate: async () => { root.resolve({ exitCode: 0 }); tree.resolve() } })
      return { ...lease, pid: state.launches, get settled() { return lease.settled }, io: { async write() {}, async endInput() {}, output: (async function* () { try { yield { channel: 'stdout' as const, data: Buffer.from('controlled') }; await root.promise } finally { io.resolve() } })() } }
    } } },
  }), async dispose() {} } } }
})

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionService } from '@i-harness/session-executor'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createDesktopExecution } from '../src/execution.ts'
import { createExecutionHostObservation } from '../src/execution-host-observation.ts'
it('composes the actual registered Exec source with the private retained lease and detaches it on retirement', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'adapter-exec-source-'))
  const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root), owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    await c.create({ sessionId: 's' }); await c.releaseOwnership('s')
    const assembly = await service.assemblyFor('s'), subscribe = assembly.onExecutionSurfaceChanged!.bind(assembly)
    let detached = 0
    assembly.onExecutionSurfaceChanged = listener => { const off = subscribe(listener); return () => { detached++; off() } }
    const notices: string[] = [], lease = await owner.subscribe('s', notice => notices.push(notice.kind))
    const job = await state.exec.runBackground({ argv: ['actual-controlled'] })
    await Promise.resolve(); expect(notices).toContain('invalidate')
    expect(assembly.backgroundJobs!().find(row => row.id === job.jobId)!.nativeJob).toBe(job.nativeJob)
    expect((await lease.snapshot()).kind).toBe('snapshot')
    assembly.revokeNewWork(); await new Promise(resolve => setImmediate(resolve)); expect(notices).toContain('retired')
    expect(detached).toBe(1)
    const count = notices.length
    state.controls[0]!.root.resolve({ exitCode: 0 }); state.controls[0]!.tree.resolve()
    await new Promise(resolve => setImmediate(resolve)); expect(notices).toHaveLength(count)
    await expect(lease.snapshot()).rejects.toThrow(); await lease.close(); expect(detached).toBe(1)
  } finally { for (const control of state.controls) { control.root.resolve({ exitCode: 0 }); control.tree.resolve() }; await owner.close(); await broker.close(); await service.close(); await c.close(); await rm(root, { recursive: true, force: true }) }
})
