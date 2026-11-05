import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSession, decodeFactBatch, subscribe, type BatchKey } from '@i-harness/core-session'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { registerCodeMode } from '../src/register.ts'

async function managed() {
  const root = await mkdtemp(join(tmpdir(), 'ih-surface-'))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create()
  return { backend, coordinator, id }
}

it('keeps initial readiness and the entire real admission handler unavailable through local installation', async () => {
  const { backend, coordinator, id } = await managed()
  await coordinator.append(id, [{ type: 'code/cell', cellId: 'old', state: 'started', sessionId: id, seq: 0 }])
  const document = await coordinator.openManagedDocument(id), ctx = createContext(), tools = createToolRegistry(ctx)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'code/cell' && e.state === 'interrupted')) { entered.resolve(); await release.promise }; return actual(...args) }
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  const notices: Array<{ state: string | undefined; live: number | undefined }> = []
  const off = mount.onSurfaceChanged?.(() => { notices.push({ state: mount.surfaceState?.(), live: mount.surfaceState?.() === 'available' ? mount.liveCells!().length : undefined }) })
  const offThrow = mount.onSurfaceChanged?.(() => { throw new Error('consumer failure') })
  try {
    await entered.promise
    expect(mount.surfaceState?.()).toBe('unavailable')
    release.resolve(); await mount.ready!()
    expect(mount.surfaceState?.()).toBe('available')
    const duringCommit: string[] = []
    const stop = subscribe(document.view, event => { if (event.type === 'code/cell' && event.state === 'started') duringCommit.push(mount.surfaceState?.() ?? 'missing') })
    const beforeStart = notices.length
    const result = await tools.get('code_exec')!.execute({ code: 'await new Promise(() => {})', yield_time_ms: 0 }, { session: document.view, sessionId: id }) as { cell_id: string }
    stop()
    expect(notices.slice(beforeStart).find(notice => notice.state === 'available')).toEqual({ state: 'available', live: 1 })
    expect(duringCommit).toEqual(['unavailable'])
    expect(notices).toContainEqual({ state: 'available', live: 1 })
    await mount.terminateCell!(result.cell_id)
    expect(notices.at(-1)).toEqual({ state: 'available', live: 0 })
    off?.(); const count = notices.length
    const closing = mount.dispose()
    expect(mount.surfaceState?.()).toBe('retired')
    await closing
    expect(notices).toHaveLength(count)
  } finally { release.resolve(); off?.(); offThrow?.(); await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('publishes late original terminal installation after rejection without letting passive getters recover it', async () => {
  const { backend, coordinator, id } = await managed(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let key: BatchKey | undefined, blocked = true, reconciles = 0
  const actual = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { const result = await actual(...args); if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'code/cell' && e.state === 'terminated')) { key = args[3].key; return { kind: 'unknown', key } }; return result }
  backend.reconcileOwnedBatch = async (...args) => { reconciles++; return blocked ? { kind: 'unknown', key: args[3].key } : reconcile(...args) }
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  const notices: string[] = []
  const off = mount.onSurfaceChanged?.(() => notices.push(mount.surfaceState?.() ?? 'missing'))
  try {
    await mount.ready!()
    const result = await tools.get('code_exec')!.execute({ code: 'await new Promise(() => {})', yield_time_ms: 0 }, { session: document.view, sessionId: id }) as { cell_id: string }
    await expect(tools.get('code_wait')!.execute({ cell_id: result.cell_id, terminate: true, yield_time_ms: 5000 }, { session: document.view, sessionId: id })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    const before = reconciles
    expect(mount.surfaceState?.()).toBe('unavailable'); expect(mount.surfaceState?.()).toBe('unavailable')
    expect(reconciles).toBe(before)
    blocked = false; await document.reconcile(key!)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mount.surfaceState?.()).toBe('available')
    expect(mount.liveCells!()).toEqual([])
    expect(notices.at(-1)).toBe('available')
  } finally { blocked = false; off?.(); await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('keeps a nondurable terminal unavailable until its real flush and local removal finish', async () => {
  const session = createSession(), ctx = createContext(), tools = createToolRegistry(ctx)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: 'mixed' }, flush: async () => { entered.resolve(); await release.promise } })
  try {
    await mount.ready!()
    const result = tools.get('code_exec')!.execute({ code: 'text("done")', yield_time_ms: 5000 }, { session })
    await entered.promise
    expect(session.events.at(-1)).toMatchObject({ type: 'code/cell', state: 'completed' })
    expect(mount.surfaceState?.()).toBe('unavailable')
    release.resolve(); await result
    expect(mount.surfaceState?.()).toBe('available'); expect(mount.liveCells!()).toEqual([])
  } finally { release.resolve(); await mount.dispose() }
})


it('keeps failed nondurable installation unavailable after the handler unwinds', async () => {
  const session = createSession(), ctx = createContext(), tools = createToolRegistry(ctx)
  let fail = true
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: 'mixed' }, flush: async () => { if (fail) throw new Error('original flush failed') } })
  try {
    await mount.ready!()
    await expect(tools.get('code_exec')!.execute({ code: 'text("done")', yield_time_ms: 5000 }, { session })).resolves.toMatchObject({ status: 'failed', error: 'original flush failed' })
    expect(mount.surfaceState?.()).toBe('unavailable')
  } finally { fail = false; await mount.dispose().catch(() => {}) }
})

it('never installs or resumes a rejected original start when its late receipt reconciles', async () => {
  const { backend, coordinator, id } = await managed(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let key: BatchKey | undefined, blocked = true, bodies = 0
  tools.register({ name: 'probe', description: '', inputSchema: {}, async execute() { bodies++; return 1 } })
  const actual = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { const result = await actual(...args); if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'code/cell' && e.state === 'started')) { key = args[3].key; return { kind: 'unknown', key } }; return result }
  backend.reconcileOwnedBatch = async (...args) => blocked ? { kind: 'unknown', key: args[3].key } : reconcile(...args)
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  let notices = 0
  const off = mount.onSurfaceChanged?.(() => { notices++ })
  try {
    await mount.ready!()
    await expect(tools.get('code_exec')!.execute({ code: 'text(await tools.probe({}))', yield_time_ms: 5000 }, { session: document.view, sessionId: id })).rejects.toThrow('Code Mode event settlement requires recovery')
    expect(mount.surfaceState?.()).toBe('unavailable')
    const before = notices
    blocked = false; await document.reconcile(key!)
    await expect.poll(() => document.view.events.filter(e => e.type === 'code/cell').map(e => e.state)).toEqual(['started', 'interrupted'])
    expect(mount.surfaceState?.()).toBe('available')
    expect(mount.liveCells!()).toEqual([])
    expect(bodies).toBe(0)
    expect(notices).toBeGreaterThan(before)
  } finally { blocked = false; off?.(); await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})



it('publishes cancelled store bookkeeping only after the original held admission is discarded', async () => {
  const { backend, coordinator, id } = await managed(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'code/store')) { entered.resolve(); await release.promise }; return actual(...args) }
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  const states: string[] = []
  mount.onSurfaceChanged?.(() => states.push(mount.surfaceState!()))
  const observing = tools.get('code_exec')!.execute({ code: 'store("discard", 7)', yield_time_ms: 5000 }, { session: document.view, sessionId: id })
  void observing.catch(() => {})
  try {
    await entered.promise
    expect(mount.surfaceState?.()).toBe('unavailable')
    const stopping = mount.cancel('Stop before actual store issue')
    release.resolve(); await stopping
    await expect(observing).resolves.toMatchObject({ status: 'terminated' })
    expect(mount.surfaceState?.()).toBe('available')
    expect(states.at(-1)).toBe('available')
    expect(document.view.events.filter(e => e.type === 'code/store')).toEqual([])
    expect(mount.liveCells!()).toEqual([])
  } finally { release.resolve(); await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('retains the original reconciliation subscription through failed close after consumer detach', async () => {
  const { backend, coordinator, id } = await managed(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let key: BatchKey | undefined, blocked = true
  const actual = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { const result = await actual(...args); if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'code/cell' && e.state === 'terminated')) { key = args[3].key; return { kind: 'unknown', key } }; return result }
  backend.reconcileOwnedBatch = async (...args) => blocked ? { kind: 'unknown', key: args[3].key } : reconcile(...args)
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  let notifications = 0
  const off = mount.onSurfaceChanged?.(() => { notifications++ })
  try {
    const result = await tools.get('code_exec')!.execute({ code: 'await new Promise(() => {})', yield_time_ms: 0 }, { session: document.view, sessionId: id }) as { cell_id: string }
    await expect(tools.get('code_wait')!.execute({ cell_id: result.cell_id, terminate: true, yield_time_ms: 5000 }, { session: document.view, sessionId: id })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(mount.dispose()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(mount.surfaceState?.()).toBe('retired')
    off?.(); const before = notifications
    blocked = false; await document.reconcile(key!)
    await expect.poll(() => mount.liveCells!()).toEqual([])
    expect(mount.surfaceState?.()).toBe('retired')
    expect(notifications).toBe(before)
    await mount.dispose()
  } finally { blocked = false; off?.(); await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})
