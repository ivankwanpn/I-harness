import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
it('keeps actual private cold observation passive under one pre-construction clock', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  async function finite<T>(work: Promise<T>): Promise<T> { let done = false; const result = work.finally(() => { done = true }); void result.catch(() => {}); while (!done) { await new Promise(resolve => setImmediate(resolve)); await vi.advanceTimersByTimeAsync(0) }; return result }
  let cleanup = async () => {}
  try {
    const [{ createJsonlBackend }, { composeJsonlTaskTransitionCoordinator }, { taskDocumentStorageContract }, { createSessionService }, { createProjectScopeBroker }, { createDesktopExecution }, { createExecutionHostObservation }] = await finite(Promise.all([import('@i-harness/session-persistence-jsonl'), import('@i-harness/session-persistence-jsonl/internal/task-document-factory'), import('@i-harness/subagent/internal/task-storage-contract'), import('@i-harness/session-executor'), import('../src/project-scope.ts'), import('../src/execution.ts'), import('../src/execution-host-observation.ts')]))
    const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'private-owner-idle-'))
    const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
    let modelCalls = 0
    const service = createSessionService({ workspace: root, coordinator: c, model: { async *stream() { modelCalls++; yield { type: 'end' as const } } } }), broker = createProjectScopeBroker(c, root), execution = createDesktopExecution(c, service)
    const reads = [vi.spyOn(c, 'profile'), vi.spyOn(c, 'snapshot'), vi.spyOn(execution, 'read'), vi.spyOn(service, 'assemblyFor'), vi.spyOn(service, 'liveAssembly')]
    const owner = createExecutionHostObservation(c, broker, service, execution)
    cleanup = async () => { await owner.close(); await broker.close(); await service.close(); await c.close(); await rm(root, { recursive: true, force: true }) }
    await finite(c.create({ sessionId: 's' })); await finite(c.releaseOwnership('s'))
    const notices: string[] = [], lease = await finite(owner.subscribe('s', notice => notices.push(notice.kind)))
    expect((await finite(lease.snapshot())).kind).toBe('snapshot'); reads.forEach(read => read.mockClear())
    await vi.advanceTimersByTimeAsync(600_000)
    expect(notices).toEqual([]); expect(modelCalls).toBe(0); reads.forEach(read => expect(read).not.toHaveBeenCalled()); expect(vi.getTimerCount()).toBe(0)
    await finite(lease.close()); reads.forEach(read => read.mockClear())
    await vi.advanceTimersByTimeAsync(600_000)
    expect(notices.filter(kind => kind === 'invalidate')).toEqual([]); expect(modelCalls).toBe(0); reads.forEach(read => expect(read).not.toHaveBeenCalled()); expect(vi.getTimerCount()).toBe(0)
    await finite(service.assemblyFor('s'))
    const live = await finite(owner.subscribe('s', notice => notices.push(notice.kind)))
    expect((await finite(live.snapshot())).kind).toBe('snapshot'); reads.forEach(read => read.mockClear())
    const liveBaseline = notices.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(notices).toHaveLength(liveBaseline); expect(modelCalls).toBe(0); reads.forEach(read => expect(read).not.toHaveBeenCalled()); expect(vi.getTimerCount()).toBe(0)
    await finite(live.close()); reads.forEach(read => read.mockClear()); const retiredBaseline = notices.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(notices).toHaveLength(retiredBaseline); expect(modelCalls).toBe(0); reads.forEach(read => expect(read).not.toHaveBeenCalled()); expect(vi.getTimerCount()).toBe(0)
  } finally { try { await finite(cleanup()) } finally { vi.useRealTimers() } }
}, 15000)
