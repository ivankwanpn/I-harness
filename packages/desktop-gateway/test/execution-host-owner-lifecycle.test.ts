import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createSessionService } from '@i-harness/session-executor'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createDesktopExecution } from '../src/execution.ts'
import { createExecutionHostObservation } from '../src/execution-host-observation.ts'

it('fences and joins held genuine acquisition before returning adapter close', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'adapter-late-'))
  const backend = createJsonlBackend(root), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let hold = false
  const c = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
  const original = c.retainExistingSessionBindingObservation!.bind(c)
  c.retainExistingSessionBindingObservation = async (...args) => { const ref = await original(...args); if (hold) { entered.resolve(); await gate.promise }; return ref }
  const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock' }), broker = createProjectScopeBroker(c, root)
  const owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  try {
    await c.create({ sessionId: 's' }); await c.releaseOwnership('s'); hold = true
    const subscribing = owner.subscribe('s', () => {}); void subscribing.catch(() => {})
    await entered.promise
    let done = false; const closing = owner.close().then(() => { done = true })
    await new Promise(resolve => setImmediate(resolve)); expect(done).toBe(false)
    gate.resolve(); await expect(subscribing).rejects.toThrow(); await closing
    expect(c.hasLiveOwnership?.('s')).toBe(false)
    const foreign = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }, taskDocumentStorageContract)
    try { await foreign.adoptOwnership('s'); await foreign.releaseOwnership('s') } finally { await foreign.close() }
  } finally { gate.resolve(); await owner.close(); await broker.close(); await service.close(); await c.close(); await rm(root, { recursive: true, force: true }) }
})

async function fixture(options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'adapter-real-'))
  const c = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } }, taskDocumentStorageContract)
  await c.create({ sessionId: 's' }); await c.releaseOwnership('s')
  const service = createSessionService({ workspace: root, coordinator: c, modelPolicy: 'test-mock', ...options }), broker = createProjectScopeBroker(c, root)
  const owner = createExecutionHostObservation(c, broker, service, createDesktopExecution(c, service))
  return { c, service, broker, owner, async close() { await owner.close(); await broker.close(); await service.close(); await c.close(); await rm(root, { recursive: true, force: true }) } }
}

it('uses actual cold/live source epochs and never converts a retiring owner into cold', async () => {
  const f = await fixture()
  try {
    const cold = await f.owner.subscribe('s', () => {})
    expect((await cold.snapshot()).kind).toBe('snapshot')
    await cold.close()
    const assembly = await f.service.assemblyFor('s')
    expect(assembly.executionSurfaceState?.()).toBe('available')
    const live = await f.owner.subscribe('s', () => {})
    expect((await live.snapshot()).kind).toBe('snapshot'); expect(live.epoch).not.toBe(cold.epoch)
    assembly.revokeNewWork(); await expect(live.snapshot()).rejects.toThrow()
    await expect(f.owner.subscribe('s', () => {})).rejects.toThrow()
    await live.close(); await f.service.closeSession('s')
    const replacement = await f.service.assemblyFor('s'); expect(replacement).not.toBe(assembly)
    const fresh = await f.owner.subscribe('s', () => {}); expect(fresh.epoch).not.toBe(live.epoch); expect((await fresh.snapshot()).kind).toBe('snapshot'); await fresh.close()
    await expect(live.snapshot()).rejects.toThrow()
  } finally { await f.close() }
})

it('refunds natural broker retirement and fences every lease before independent disposal', async () => {
  const f = await fixture()
  try {
    for (let index = 0; index < 34; index++) {
      const lease = await f.owner.subscribe('s', () => {})
      await f.broker.configureReferences([])
      await expect(lease.snapshot()).rejects.toThrow()
    }
    const lease = await f.owner.subscribe('s', () => {})
    f.owner.fence()
    await expect(lease.snapshot()).rejects.toThrow()
    await expect(f.owner.subscribe('s', () => {})).rejects.toThrow()
    await f.owner.close()
  } finally { await f.close() }
})

it('preserves independent falsey disposer debt until explicit retry', async () => {
  const f = await fixture()
  const original = f.service.onExecutionSurfaceLifecycle!.bind(f.service)
  let fail = true, disposals = 0
  f.service.onExecutionSurfaceLifecycle = (...args) => { const off = original(...args); return () => { disposals++; if (fail) { fail = false; throw false }; off() } }
  try {
    const lease = await f.owner.subscribe('s', () => {})
    await expect(lease.close()).rejects.toBe(false)
    await expect(lease.snapshot()).rejects.toThrow()
    await lease.close(); expect(disposals).toBe(2)
    const next = await f.owner.subscribe('s', () => {}); await next.close()
  } finally { await f.close() }
})

it('rejects unavailable original live source without relabeling it as cold', async () => {
  const f = await fixture({ codeMode: { mode: 'mixed' }, codeModeFactory: () => ({ schemas: () => [], async cancel() {}, async dispose() {} }) })
  try {
    const assembly = await f.service.assemblyFor('s')
    expect(assembly.executionSurfaceState?.()).toBe('unavailable')
    await expect(f.owner.subscribe('s', () => {})).rejects.toThrow('unavailable')
  } finally { await f.close() }
})

it('keeps all 32 provisional slots charged until late acquisition disposal completes', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const acquire = f.c.retainExistingSessionBindingObservation!.bind(f.c)
  let arrivals = 0
  f.c.retainExistingSessionBindingObservation = async (...args) => { const ref = await acquire(...args); if (++arrivals === 32) entered.resolve(); await gate.promise; return ref }
  try {
    const requests = Array.from({ length: 32 }, () => f.owner.subscribe('s', () => {})); requests.forEach(request => void request.catch(() => {}))
    await entered.promise
    await expect(f.owner.subscribe('s', () => {})).rejects.toThrow()
    const closing = f.owner.close(); let closed = false; void closing.then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false)
    gate.resolve(); expect((await Promise.allSettled(requests)).every(result => result.status === 'rejected')).toBe(true); await closing
  } finally { gate.resolve(); await f.close() }
})

it('rejects actual includeExisting failed-cleanup ownership instead of producing a cold lease', async () => {
  let fail = true
  const f = await fixture({ codeMode: { mode: 'mixed' }, codeModeFactory: () => ({ schemas: () => [], surfaceState: () => 'available', onSurfaceChanged: () => () => {}, async cancel() {}, async dispose() { if (fail) throw Error('actual mount debt') } }) })
  try {
    await f.service.assemblyFor('s'); await expect(f.service.closeSession('s')).rejects.toThrow()
    expect(f.service.liveAssembly('s')).toBeUndefined()
    await expect(f.owner.subscribe('s', () => {})).rejects.toThrow()
    fail = false; await f.service.closeSession('s')
    const fresh = await f.owner.subscribe('s', () => {}); expect((await fresh.snapshot()).kind).toBe('snapshot'); await fresh.close()
  } finally { fail = false; await f.close() }
})

it('uses actual Workflow collection for coalesced dirtiness and reset during a real read', async () => {
  const f = await fixture()
  const { createWorkflowExecutor } = await import('../../workflow/src/index.ts')
  const gate = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>()
  const workflow = createWorkflowExecutor({ exec: { run: () => gate.promise } as never })
  try {
    await f.service.assemblyFor('s')
    const notices: string[] = [], lease = await f.owner.subscribe('s', notice => notices.push(notice.kind))
    const run = workflow.runWorkflow({ name: 'actual', description: 'controlled', steps: [{ name: 'step', command: 'controlled' }] }, {}, 's')
    workflow.killJob(run.jobId) // two original collection mutations in one turn
    await Promise.resolve(); expect(notices).toEqual(['invalidate'])
    const view = await lease.snapshot(); expect(view.kind).toBe('snapshot')
    await lease.close(); workflow.killJob(run.jobId)
    gate.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
  } finally { gate.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false }); await f.close() }
})

it('retained retirement sinks allow selected resource joins and reject full adapter close even after detachment', async () => {
  const f = await fixture(), acquire = f.c.retainExistingSessionBindingObservation!.bind(f.c)
  let refusals = 0
  f.c.retainExistingSessionBindingObservation = async (request, retired) => {
    const ref = await acquire(request, async operation => { await retired(operation); await Promise.resolve(); await expect(f.owner.close()).rejects.toThrow(/retirement sink/i); refusals++; await ref.release(operation) })
    return ref
  }
  try {
    const lease = await f.owner.subscribe('s', () => {})
    await f.broker.configureReferences([]); expect(refusals).toBe(1)
    await expect(lease.snapshot()).rejects.toThrow()
    const fresh = await f.owner.subscribe('s', () => {}); await fresh.close()
  } finally { await f.close() }
})

it('resets an actual read dirtied by original Workflow settlement and preserves literal read failure', async () => {
  const f = await fixture(), { createWorkflowExecutor } = await import('../../workflow/src/index.ts')
  const gate = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>()
  const workflow = createWorkflowExecutor({ exec: { run: () => gate.promise } as never })
  let owner: ReturnType<typeof createExecutionHostObservation> | undefined
  try {
    await f.service.assemblyFor('s')
    const run = workflow.runWorkflow({ name: 'reset', description: 'reset', steps: [{ name: 'step', command: 'controlled' }] }, {}, 's')
    const execution = createDesktopExecution(f.c, f.service), original = execution.read.bind(execution)
    let fail = false
    execution.read = async (...args) => { const value = await original(...args); if (fail) throw undefined; workflow.killJob(run.jobId); return value }
    owner = createExecutionHostObservation(f.c, f.broker, f.service, execution)
    const lease = await owner.subscribe('s', () => {})
    expect((await lease.snapshot()).kind).toBe('reset')
    fail = true; await expect(lease.snapshot()).rejects.toBeUndefined()
    await lease.close()
  } finally { gate.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false }); await owner?.close(); await f.close() }
})

it('holds one snapshot flight across close and refuses a later DTO without releasing resources early', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const execution = createDesktopExecution(f.c, f.service), original = execution.read.bind(execution)
  execution.read = async (...args) => { entered.resolve(); await gate.promise; return original(...args) }
  const owner = createExecutionHostObservation(f.c, f.broker, f.service, execution)
  try {
    const lease = await owner.subscribe('s', () => {})
    const reading = lease.snapshot(); void reading.catch(() => {}); await entered.promise
    expect((await lease.snapshot()).kind).toBe('reset')
    let closed = false; const closing = lease.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false)
    gate.resolve(); await expect(reading).rejects.toThrow(); await closing
  } finally { gate.resolve(); await owner.close(); await f.close() }
})

it('classifies actual managed Code Mode publication and cold writes without certifying pre-mutation retirement as completion', async () => {
  const f = await fixture({ codeMode: { mode: 'mixed' } })
  try {
    const assembly = await f.service.assemblyFor('s'), notices: string[] = []
    const lease = await f.owner.subscribe('s', notice => notices.push(notice.kind))
    const result = await assembly.tools.execute({ name: 'code_exec', args: { code: 'text("original-managed-cell")', yield_time_ms: 0 } })
    const id = (result.output as { cell_id: string }).cell_id
    await new Promise(resolve => setImmediate(resolve))
    expect(typeof id).toBe('string')
    expect(assembly.session.events.some(event => event.type === 'code/cell' && event.cellId === id)).toBe(true)
    expect(notices).toContain('retired'); await expect(lease.snapshot()).rejects.toThrow()
    // The original binding owner may retire before producer completion. This
    // is terminal authority loss, not evidence of a complete managed feed.
    await lease.close()
    await f.service.closeSession('s')
    const coldNotices: string[] = [], cold = await f.owner.subscribe('s', notice => coldNotices.push(notice.kind))
    await f.c.append('s', [{ type: 'plan/mode', mode: 'on' }])
    expect(coldNotices).toContain('retired'); await expect(cold.snapshot()).rejects.toThrow()
    await cold.close()
  } finally { await f.close() }
}, 15000)

it('rejects provisional cold-to-live publication and detaches a late-returned original disposer', async () => {
  const f = await fixture(), acquire = f.c.retainExistingSessionBindingObservation!.bind(f.c), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  f.c.retainExistingSessionBindingObservation = async (...args) => { const ref = await acquire(...args); entered.resolve(); await gate.promise; return ref }
  try {
    const subscribing = f.owner.subscribe('s', () => {}); void subscribing.catch(() => {})
    await entered.promise
    await f.service.assemblyFor('s')
    gate.resolve(); await expect(subscribing).rejects.toThrow()
  } finally { gate.resolve(); await f.close() }
})

it('preflights self-read full close before fencing and preserves falsey primary acquisition failure with cleanup failure', async () => {
  const f = await fixture(), acquire = f.c.retainExistingSessionBindingObservation!.bind(f.c)
  let ref: Awaited<ReturnType<typeof acquire>> | undefined
  f.c.retainExistingSessionBindingObservation = async (...args) => ref = await acquire(...args)
  try {
    const lease = await f.owner.subscribe('s', () => {})
    await ref!.withRead(async () => { await expect(f.owner.close()).rejects.toThrow(); ref!.assertCurrent() })
    expect((await lease.snapshot()).kind).toBe('snapshot'); await lease.close()
    const lifecycle = f.service.onExecutionSurfaceLifecycle!.bind(f.service)
    let fail = true
    f.service.onExecutionSurfaceLifecycle = (...args) => { const off = lifecycle(...args); return () => { if (fail) { fail = false; throw false }; off() } }
    f.c.retainExistingSessionBindingObservation = async () => { throw undefined }
    let failure: unknown
    try { await f.owner.subscribe('s', () => {}) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors[0]).toBeUndefined()
    await f.owner.close()
  } finally { await f.close() }
})

it('keeps async retirement notices in the original sink domain through a delayed full-close refusal', async () => {
  const f = await fixture()
  try {
    const lease = await f.owner.subscribe('s', async notice => { if (notice.kind === 'retired') { await Promise.resolve(); await f.owner.close() } })
    await expect(f.broker.configureReferences([])).rejects.toThrow()
    await expect(lease.snapshot()).rejects.toThrow()
    // Refusal happened before owner shutdown admission; fresh authorization
    // is possible after the initiating mutation reported its sink failure.
    const fresh = await f.owner.subscribe('s', () => {}); await fresh.close()
  } finally { await f.close().catch(() => {}) }
})


it('revalidates the actual source availability certificate and never revives the old epoch after ABA', async () => {
  let state: 'available' | 'unavailable' = 'available', changed = () => {}
  const f = await fixture({ codeMode: { mode: 'mixed' }, codeModeFactory: () => ({ schemas: () => [], liveCells: () => [], surfaceState: () => state, onSurfaceChanged(listener: () => void) { changed = listener; return () => {} }, async cancel() {}, async dispose() {} }) })
  try {
    await f.service.assemblyFor('s')
    const old = await f.owner.subscribe('s', () => {})
    state = 'unavailable'; changed(); await expect(old.snapshot()).rejects.toThrow()
    await old.close()
    state = 'available'; changed()
    const fresh = await f.owner.subscribe('s', () => {}); expect(fresh.epoch).not.toBe(old.epoch)
    expect((await fresh.snapshot()).kind).toBe('snapshot'); await expect(old.snapshot()).rejects.toThrow(); await fresh.close()
  } finally { await f.close() }
})

it('concurrent external lease and owner closes join the full held sink boundary', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  try {
    const lease = await f.owner.subscribe('s', async notice => { if (notice.kind === 'retired') { entered.resolve(); await gate.promise } })
    const first = lease.close(); await entered.promise
    expect(lease.close()).toBe(first)
    let closed = false; const ownerClosing = f.owner.close().then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false)
    gate.resolve(); await first; await ownerClosing
  } finally { gate.resolve(); await f.close() }
})

it('checks the genuine retained identity against the requested session before any read authority', async () => {
  const f = await fixture(), acquire = f.c.retainExistingSessionBindingObservation!.bind(f.c)
  try {
    await f.c.create({ sessionId: 't' }); await f.c.releaseOwnership('t')
    f.c.retainExistingSessionBindingObservation = (request, retired) => acquire({ ...request, sessionId: 't' }, retired)
    await expect(f.owner.subscribe('s', () => {})).rejects.toThrow('identity mismatch')
  } finally { await f.close() }
})

it.each(['lease-close', 'service-replace', 'snapshot-false'] as const)('holds the actual original cold snapshot across %s without releasing its DTO', async mode => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const original = f.c.snapshot!.bind(f.c)
  let armed = true
  f.c.snapshot = async (...args) => { const value = await original(...args); if (armed) { armed = false; entered.resolve(); await gate.promise; if (mode === 'snapshot-false') throw false }; return value }
  try {
    const lease = await f.owner.subscribe('s', () => {})
    const reading = lease.snapshot(); void reading.catch(() => {}); await entered.promise
    const changing = mode === 'lease-close' ? lease.close() : mode === 'service-replace' ? f.service.assemblyFor('s') : Promise.resolve()
    void changing.catch(() => {})
    await new Promise(resolve => setImmediate(resolve)); gate.resolve()
    if (mode === 'snapshot-false') await expect(reading).rejects.toBe(false)
    else await expect(reading).rejects.toThrow()
    await changing; await lease.close()
    const fresh = await f.owner.subscribe('s', () => {}); expect(fresh.epoch).not.toBe(lease.epoch); expect((await fresh.snapshot()).kind).toBe('snapshot'); await fresh.close()
  } finally { gate.resolve(); await f.close() }
})

it('joins an asynchronously settling original unsubscribe before reporting lease cleanup', async () => {
  const f = await fixture(), subscribe = f.service.onExecutionSurfaceLifecycle!.bind(f.service), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  f.service.onExecutionSurfaceLifecycle = (...args) => { const off = subscribe(...args); return async () => { entered.resolve(); await gate.promise; off() } }
  try {
    const lease = await f.owner.subscribe('s', () => {})
    let closed = false; const closing = lease.close().then(() => { closed = true })
    await entered.promise; await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false)
    gate.resolve(); await closing
  } finally { gate.resolve(); await f.close() }
})
