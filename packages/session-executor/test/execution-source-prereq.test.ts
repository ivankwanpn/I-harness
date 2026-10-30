import { it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ exec: undefined as any, workflow: undefined as any, attached: { exec: 0, workflow: 0 }, detached: { exec: 0, workflow: 0 }, launches: 0, controls: [] as { root: PromiseWithResolvers<{ exitCode: number }>; tree: PromiseWithResolvers<void> }[] }))
vi.mock('@i-harness/exec', async original => {
  const actual = await original<any>()
  return { ...actual, registerExec(...args: any[]) {
    const service = actual.registerExec(...args), subscribe = service.subscribeJobs.bind(service)
    service.subscribeJobs = (listener: () => void) => { state.attached.exec++; const off = subscribe(listener); return () => { state.detached.exec++; off() } }
    state.exec = service; return service
  } }
})
vi.mock('@i-harness/workflow', async original => {
  const actual = await original<any>()
  return { ...actual, registerWorkflow(...args: any[]) {
    const mount = actual.registerWorkflow(...args), subscribe = mount.executor.subscribeJobs.bind(mount.executor)
    mount.executor.subscribeJobs = (listener: () => void) => { state.attached.workflow++; const off = subscribe(listener); return () => { state.detached.workflow++; off() } }
    state.workflow = mount.executor; return mount
  } }
})
vi.mock('@i-harness/sandbox-local', async original => {
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
import { createSessionService } from '../src/service.ts'

it('forwards the real registered Exec collection and detaches both owners once through retirement and cleanup retry', async () => {
  let failCleanup = true
  const owner = createSessionService({ workspace: process.cwd(), modelPolicy: 'test-mock', codeMode: { mode: 'mixed' }, codeModeFactory: () => ({ schemas: () => [], surfaceState: () => 'available', onSurfaceChanged: () => () => {}, async cancel() {}, async dispose() { if (failCleanup) throw Error('controlled original cleanup failure') } }) })
  try {
    const assembly = await owner.assemblyFor('original-owner')
    expect(state.attached).toEqual({ exec: 1, workflow: 1 })
    const seen: any[][] = []
    assembly.onExecutionSurfaceChanged!(() => { throw Error('first consumer fails') })
    const off = assembly.onExecutionSurfaceChanged!(() => seen.push(assembly.backgroundJobs!()))
    expect(seen).toEqual([])
    const first = await state.exec.runBackground({ argv: ['controlled-first'] })
    expect(seen.some(rows => rows.some(row => row.nativeJob?.instanceId === first.nativeJob.instanceId && row.status === 'running'))).toBe(true)
    expect(seen.flat().find(row => row.nativeJob?.instanceId === first.nativeJob.instanceId)!.nativeJob).toBe(first.nativeJob)
    state.controls[0]!.root.resolve({ exitCode: 0 }); state.controls[0]!.tree.resolve()
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
    expect(seen.some(rows => rows.some(row => row.nativeJob?.instanceId === first.nativeJob.instanceId && row.status === 'completed'))).toBe(true)
    const idleCount = seen.length, launchCount = state.launches
    const idleReads = [vi.spyOn(assembly, 'executionBackendStatus'), vi.spyOn(assembly, 'backgroundJobs'), vi.spyOn(state.exec, 'listJobViews'), vi.spyOn(state.workflow, 'listJobs')]
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(600_000)
    expect(seen).toHaveLength(idleCount); expect(state.launches).toBe(launchCount)
    idleReads.forEach(read => { expect(read).not.toHaveBeenCalled(); read.mockRestore() }); vi.useRealTimers()
    const second = await state.exec.runBackground({ argv: ['controlled-second'] })
    expect(seen.at(-1)!.some(row => row.nativeJob?.instanceId === second.nativeJob.instanceId)).toBe(true)
    assembly.revokeNewWork(); assembly.revokeNewWork()
    expect(state.detached).toEqual({ exec: 1, workflow: 1 })
    const retiredCount = seen.length
    state.controls[1]!.root.resolve({ exitCode: 0 }); state.controls[1]!.tree.resolve()
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
    expect(seen).toHaveLength(retiredCount)
    await expect(assembly.dispose()).rejects.toThrow()
    failCleanup = false; await assembly.dispose(); await assembly.dispose()
    expect(state.detached).toEqual({ exec: 1, workflow: 1 }); expect(state.launches).toBe(2)
    off()
    const status = vi.spyOn(assembly, 'executionBackendStatus'), jobs = vi.spyOn(assembly, 'backgroundJobs'), execRead = vi.spyOn(state.exec, 'listJobViews'), workflowRead = vi.spyOn(state.workflow, 'listJobs')
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(seen).toHaveLength(retiredCount)
    for (const read of [status, jobs, execRead, workflowRead]) expect(read).not.toHaveBeenCalled()
    vi.useRealTimers()
  } finally { vi.useRealTimers(); failCleanup = false; for (const control of state.controls) { control.root.resolve({ exitCode: 0 }); control.tree.resolve() }; await owner.close() }
})
