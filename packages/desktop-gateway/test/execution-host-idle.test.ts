import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const io = vi.hoisted(() => ({ reads: 0, scans: 0, opens: 0 }))
const journal = vi.hoisted(()=>({unknown:false}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async original=>{
 const module=await original<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
 return {...module,createFactJournalBackend(...args:Parameters<typeof module.createFactJournalBackend>){
  const original=module.createFactJournalBackend(...args)
  return {...original,async appendOwnedBatch(...values:Parameters<typeof original.appendOwnedBatch>){const result=await original.appendOwnedBatch(...values);return journal.unknown?{kind:'unknown' as const,key:values[3].key}:result}}
 }}
})
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs,
 readFile: (...args: Parameters<typeof fs.readFile>) => { io.reads++; return fs.readFile(...args) },
 readdir: (...args: Parameters<typeof fs.readdir>) => { io.scans++; return fs.readdir(...args) },
 open: (...args: Parameters<typeof fs.open>) => { io.opens++; return fs.open(...args) },
} })
it('keeps actual private cold observation passive under one pre-construction clock', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  async function finite<T>(work: Promise<T>): Promise<T> { let done = false; const result = work.finally(() => { done = true }); void result.catch(() => {}); while (!done) { await new Promise(resolve => setImmediate(resolve)); await vi.advanceTimersByTimeAsync(0) }; return result }
  let cleanup = async () => {}
  try {
    const [{ createJsonlBackend }, { composeJsonlTaskTransitionCoordinator }, { taskDocumentStorageContract }, { createSessionService }, { createProjectScopeBroker }, { createDesktopExecution }, { createExecutionHostObservation }] = await finite(Promise.all([import('@i-harness/session-persistence-jsonl'), import('@i-harness/session-persistence-jsonl/internal/task-document-factory'), import('@i-harness/subagent/internal/task-storage-contract'), import('@i-harness/session-executor'), import('../src/project-scope.ts'), import('../src/execution.ts'), import('../src/execution-host-observation.ts')]))
    const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'private-owner-idle-'))
    const backend = createJsonlBackend(root), c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
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
    const assembly = service.liveAssembly('s')!, doc = assembly.managedDocument!, action = doc.beginAction()
    const active = await finite(owner.subscribe('s', notice => notices.push(notice.kind)))
    journal.unknown=true
    const pending = await finite(action.facts.code.record({type:'code/cell',cellId:'idle-recovered',state:'started'}))
    expect(pending.kind).toBe('unknown'); await expect(active.snapshot()).rejects.toThrow(); await finite(active.close())
    if(pending.kind!=='unknown') throw Error('unknown required')
    journal.unknown=false; expect((await finite(doc.reconcile(pending.key))).kind).toBe('committed')
    const recovered = await finite(owner.subscribe('s', notice => notices.push(notice.kind)))
    expect(recovered.epoch).not.toBe(active.epoch); expect((await finite(recovered.snapshot())).kind).toBe('snapshot')
    async function idle() {
      reads.forEach(read=>read.mockClear()); io.reads=0; io.scans=0; io.opens=0; const baseline=notices.length
      await vi.advanceTimersByTimeAsync(600_000)
      expect(notices).toHaveLength(baseline); expect(modelCalls).toBe(0); reads.forEach(read=>expect(read).not.toHaveBeenCalled()); expect(io).toEqual({reads:0,scans:0,opens:0}); expect(vi.getTimerCount()).toBe(0)
    }
    await idle(); doc.revokeNewWork(); await expect(recovered.snapshot()).rejects.toThrow(); await finite(recovered.close()); action.finish(); await idle()
  } finally { journal.unknown=false;try { await finite(cleanup()) } finally { vi.useRealTimers() } }
}, 15000)
