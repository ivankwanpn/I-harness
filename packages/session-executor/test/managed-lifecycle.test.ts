import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '../src/service.ts'
import { decodeFactBatch } from '@i-harness/core-session'

it('closes an attached document without an assembly and reopens a fresh incarnation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-service-document-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', codeMode: { mode: 'off' } })
  try {
    const view = await service.writableSessionFor!(id), original = await coordinator.openManagedDocument(id)
    expect(original.view).toBe(view)
    await service.closeSession(id)
    expect(() => original.beginAction()).toThrowError('FACT_CLOSED')
    const next = await service.writableSessionFor!(id)
    expect(next).not.toBe(view)
    expect(next!.events).toEqual([])
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('retains a document-only attachment when its registered real settlement cannot close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-service-retain-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', codeMode: { mode: 'off' } })
  try {
    const view = await service.writableSessionFor!(id), document = await coordinator.openManagedDocument(id)
    const source = document.beginAction().registerSettlementSource(async () => { throw Object.assign(new Error('retained real result'), { code: 'FACT_RECOVERY_REQUIRED' }) })
    source.requireRecovery()
    await expect(service.close()).rejects.toThrow()
    await expect(service.close()).rejects.toThrow()
    expect((await coordinator.openManagedDocument(id)).view).toBe(view)
    expect(coordinator.ownerOf(id)).toBe(true)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('revokes the running action before close joins its turn and writes its required terminal facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-service-revoke-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), entered = Promise.withResolvers<void>()
  let aborted = false
  const service = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, model: { async *stream(request) {
    entered.resolve()
    await new Promise<void>((_, reject) => request.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('closed')) }, { once: true }))
    yield { type: 'end' }
  } } })
  const run = service.submit(id, 'work', new AbortController().signal)
  void run.catch(() => {})
  try {
    await entered.promise
    await service.closeSession(id)
    await expect(run).rejects.toThrow()
    expect(aborted).toBe(true)
    expect((await backend.read(id)).events.at(-1)?.type).toBe('turn/end')
    expect(service.hasAssembly(id)).toBe(false)
  } finally { service.cancelRunning!(id); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
}, 3000)

it('saves received human input through a source-local recovery fault while refusing promotion and transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-service-received-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let requests = 0
  const service = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, model: { async *stream() { requests++; yield { type: 'end' } } } })
  try {
    const assembly = await service.assemblyFor(id), document = await coordinator.openManagedDocument(id)
    const action = document.beginAction()
    const failed = action.registerSettlementSource(async () => { throw Object.assign(new Error('Original outcome retained'), { code: 'FACT_RECOVERY_REQUIRED' }) })
    action.finish(); failed.requireRecovery()
    await expect(service.submit(id, 'Keep this received instruction', new AbortController().signal)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(assembly.inbox.pending()).toEqual([expect.objectContaining({ text: 'Keep this received instruction', intent: 'user' })])
    expect((await backend.read(id)).events.filter(event => event.type === 'agent/input/admitted')).toEqual([expect.objectContaining({ text: 'Keep this received instruction', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })])
    expect(document.view.events.some(event => event.type === 'agent/input/promoted' || event.type === 'turn/start')).toBe(false)
    expect(requests).toBe(0)
    await expect(service.close()).rejects.toThrow()
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('acknowledges queued cancellation only after its actual receipt and keeps pending state until then', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-service-cancel-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', codeMode: { mode: 'off' } })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    await service.assemblyFor(id)
    const inputs = await service.receivedInputFor(id)
    await inputs.admit({ inputId: 'queued', text: 'received', delivery: 'queue', intent: 'user' })
    expect(service.queue(id).map(row => row.id)).toEqual(['queued'])
    const actual = backend.appendOwnedBatch!
    backend.appendOwnedBatch = async (...args) => {
      if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/cancelled')) { entered.resolve(); await release.promise }
      return actual(...args)
    }
    let returned = false
    const cancellation = service.cancelQueued(id, 'queued').then(result => { returned = true; return result })
    await entered.promise
    expect(returned).toBe(false)
    expect(inputs.pending().map(input => input.inputId)).toEqual(['queued'])
    expect(service.queue(id).map(row => row.id)).toEqual(['queued'])
    release.resolve()
    expect(await cancellation).toEqual({ cancelled: true })
    expect(inputs.pending()).toEqual([])
    expect((await backend.read(id)).events.at(-1)).toMatchObject({ type: 'agent/input/cancelled', inputId: 'queued' })
  } finally { release.resolve(); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('holds actual assembly readiness until its previous-process Code Mode interruption receipt commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-assembly-ready-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  await document.code.record({ type: 'code/cell', cellId: 'previous', sessionId: id, state: 'started', source: 'text("previous")' })
  await document.close()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/cell' && event.state === 'interrupted')) { entered.resolve(); await release.promise }
    return actual(...args)
  }
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', codeMode: { mode: 'mixed' } })
  let ready = false
  const building = service.assemblyFor(id).then(assembly => { ready = true; return assembly })
  try {
    await entered.promise
    await Promise.resolve(); await Promise.resolve()
    expect(ready).toBe(false)
    release.resolve()
    const assembly = await building
    expect((await backend.read(id)).events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'interrupted'])
    expect(assembly.liveResources?.().codeCells).toEqual([])
  } finally { release.resolve(); await building.catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('releases a completed assembly metadata action instead of retaining its abort signal until document close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-action-scope-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', sandbox: 'read-only', codeMode: { mode: 'off' } })
  try {
    const assembly = await service.assemblyFor(id), document = await coordinator.openManagedDocument(id)
    const original = document.beginAction, observed: AbortSignal[] = []
    document.beginAction = signal => { const action = original(signal); observed.push(action.signal); return action }
    await assembly.recordSandboxMode('workspace-write')
    expect(observed).toHaveLength(1)
    document.revokeNewWork()
    expect(observed[0]!.aborted).toBe(false)
    expect(document.view.events.at(-1)).toMatchObject({ type: 'sandbox/mode', mode: 'workspace-write' })
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
