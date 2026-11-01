import { expect, it, vi } from 'vitest'
const originalOwners = vi.hoisted(() => [] as import('../../session-persistence/src/coordinator/ownership.ts').Ownership[])
const originalParticipants = vi.hoisted(() => [] as import('../../session-persistence/src/coordinator/result-ordering-types.ts').OriginalLegacyOrderingParticipant[])
const originalArtifacts = vi.hoisted(() => [] as ReturnType<typeof import('../../context-output/src/artifact/ownership.ts').createArtifactOwnership>[])
vi.mock('../../context-output/src/artifact/ownership.ts', async original => {
  const module = await original<typeof import('../../context-output/src/artifact/ownership.ts')>()
  return { ...module, createArtifactOwnership: (...args: Parameters<typeof module.createArtifactOwnership>) => { const owner = module.createArtifactOwnership(...args); originalArtifacts.push(owner); return owner } }
})
vi.mock('../../session-persistence/src/result-ordering-internal.ts', async original => {
  const module = await original<typeof import('../../session-persistence/src/result-ordering-internal.ts')>()
  return { ...module, beginOriginalResultOrderingRegistration: (...args: Parameters<typeof module.beginOriginalResultOrderingRegistration>) => {
    const registration = module.beginOriginalResultOrderingRegistration(...args)
    return { commit(participant: import('../../session-persistence/src/coordinator/result-ordering-types.ts').OriginalLegacyOrderingParticipant) { originalParticipants.push(participant); registration.commit(participant) }, cancel() { registration.cancel() } }
  } }
})
vi.mock('../../session-persistence/src/coordinator/ownership.ts', async original => {
  const module = await original<typeof import('../../session-persistence/src/coordinator/ownership.ts')>()
  return { ...module, createOwnership: (...args: Parameters<typeof module.createOwnership>) => { const owner = module.createOwnership(...args); originalOwners.push(owner); return owner } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as locking from '../../fs-lock/src/index.ts'
import { createProcessAwareResultService } from '../src/lifecycle/process-result-service.ts'
import { ContextStore } from '../../context-output/src/store.ts'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { retryOriginalResultOrdering, beginOriginalResultOrderingRegistration, originalResultOrderingFor } from '../../session-persistence/src/result-ordering-internal.ts'
import { captureHeldOwnershipClaim } from '../../session-persistence/src/coordinator/ownership.ts'

function serviceFor(root: string, coordinator: ReturnType<typeof createJsonlTaskTransitionCoordinator>, workspaceId: string, dynamic = false, authorize = async () => false) {
  return createProcessAwareResultService({ root, workspaceId, config: { enabled: true }, orderingCoordinators: dynamic ? [] : [coordinator], coordinatorFor: () => coordinator, sourceFor: async () => ({ sourceId: 'source' }), genericVisible: async () => false, authorize })
}
const capture = { sessionId: 'source', callId: 'c', label: 'c', text: 'original retained bytes', complete: true }

it('detects only genuine lock-enabled ordering capability and refuses changed original methods',async()=>{
 const root=await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!,'ordering-capability-'))
 const coordinator=createJsonlTaskTransitionCoordinator(join(root,'locked'),{lock:{enabled:true}},taskDocumentStorageContract)
 const unlocked=createJsonlTaskTransitionCoordinator(join(root,'unlocked'),{lock:{enabled:false}},taskDocumentStorageContract)
 try{
  expect(originalResultOrderingFor(unlocked)).toBeUndefined();expect(originalResultOrderingFor({...coordinator})).toBeUndefined()
  const capability=originalResultOrderingFor(coordinator)!
  expect(capability).toBeDefined();expect(()=>({...capability}).beginRegistration({})).toThrow(/Original/)
  const original=coordinator.create,changed=vi.spyOn(coordinator,'create').mockImplementation(meta=>original(meta))
  expect(()=>originalResultOrderingFor(coordinator)).toThrow(/Original/);changed.mockRestore()
 }finally{vi.restoreAllMocks();await coordinator.close();await unlocked.close();await rm(root,{recursive:true,force:true})}
})

it.each([[false,'second'],[true,'second'],[false,'cancel'],[true,'cancel']] as const)('keeps original held parent currency after ordinary aggregate extension configured=%s action=%s', async (configured, action) => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-held-currency-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract)
  const owner = originalOwners.at(-1)!, bridges: ReturnType<typeof serviceFor>[] = []
  if(configured)bridges.push(serviceFor(root,coordinator,'first'))
  const acquire=vi.spyOn(locking,'acquireSessionLock'),opened=vi.spyOn(ContextStore.prototype,'open')
  const held=await owner.pinOwnership('parent');held.retainLive()
  const original=captureHeldOwnershipClaim(owner,'parent',held), count=acquire.mock.calls.length
  try {
    if(action==='second')bridges.push(serviceFor(root,coordinator,'second'))
    else {const registration=beginOriginalResultOrderingRegistration(coordinator,{});registration.cancel()}
    held.assertHeld();original.assertHeld();held.retainLive()
    expect(acquire.mock.calls.length).toBe(count)
    for(const bridge of bridges){const ref=(await bridge.service.capture(capture))!;await expect(bridge.service.read({sessionId:'denied'},{refId:ref.id})).rejects.toThrow()}
    const stores=opened.mock.contexts as ContextStore[]
    expect(stores.every(store=>!store.lifetimeSettled())).toBe(true)
    await coordinator.create({sessionId:'fresh'})
    expect(stores.every(store=>store.lifetimeSettled())).toBe(true)
    held.assertHeld();original.assertHeld()
  } finally {await held.release();vi.restoreAllMocks();for(const bridge of bridges)await bridge.service.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it.each(['configure', 'clear'] as const)('joins the original queued %s transition before fresh native acquisition can pass', async operation => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-transition-tail-')), sessions = join(root, 'sessions')
  const coordinator = createJsonlTaskTransitionCoordinator(sessions, { lock: { enabled: true } }, taskDocumentStorageContract), bridge = serviceFor(root, coordinator, 'w')
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>(), native = locking.acquireSessionLock
  let configured = false
  const flags: boolean[] = []
  const budget = ContextStore.prototype.configureDiskBudget
  const clear = ContextStore.prototype.clear
  try {
    await bridge.service.capture(capture)
    const producer = bridge.service.capture({ ...capture, callId: 'waiting' }, undefined, async () => { entered.resolve(); await leave.promise; return { text: 'waiting', complete: true } }).catch(error => error)
    await entered.promise
    const configure = operation === 'configure' ? bridge.service.configure({ maxDiskBytes: 32 * 1024 * 1024 }) : bridge.service.clear('absent')
    const probe = operation === 'configure'
      ? vi.spyOn(ContextStore.prototype, 'configureDiskBudget').mockImplementation(function (this: ContextStore, ...args) { configured = true; return budget.apply(this, args) })
      : vi.spyOn(ContextStore.prototype, 'clear').mockImplementation(function (this: ContextStore, ...args) { configured = true; return clear.apply(this, args) })
    vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => { if (options.lockPath.startsWith(sessions)) flags.push(configured); return native(options) })
    const claim = originalOwners.at(-1)!.pinOwnership('fresh')
    leave.resolve(); await producer
    const held = await claim; await configure
    expect(flags.length).toBeGreaterThan(0); expect(flags.every(Boolean)).toBe(true)
    await held.release(); probe.mockRestore()
  } finally { leave.resolve(); vi.restoreAllMocks(); await bridge.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses the original transition context before clear enters any lower workspace or legacy gate', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-transition-self-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract), bridge = serviceFor(root, coordinator, 'w')
  const artifact = originalArtifacts.at(-1)!, count = artifact.protectedCount
  const probe = vi.spyOn(artifact, 'protectedCount').mockImplementation(async () => { expect(() => originalParticipants.at(-1)!.assertOutside()).toThrow(/reentry/); return count() })
  try { await bridge.service.clear('absent') } finally { probe.mockRestore(); await bridge.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses its original service job before a producer can wait for fresh ownership of that same job', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-producer-self-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract), bridge = serviceFor(root, coordinator, 'w')
  try {
    expect(await bridge.service.capture(capture, undefined, async () => {
      expect(() => originalParticipants.at(-1)!.assertOutside()).toThrow(/reentry/)
      return { text: capture.text, complete: true }
    })).toBeDefined()
  } finally { await bridge.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses original workspace self-entry before fresh ownership effects during managed authorization', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-workspace-self-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  let callbacks = 0
  const refused: unknown[] = []
  const bridge = createProcessAwareResultService({ root, workspaceId: 'w', orderingCoordinators: [coordinator], coordinatorFor: () => coordinator, config: { enabled: true },
    sourceFor: async () => { callbacks++; refused.push(await originalOwners.at(-1)!.pinOwnership('nested-fresh').then(() => undefined, error => error)); return { sourceId: 'source' } }, genericVisible: async () => false,
  })
  try {
    const scope = bridge.service.registerResultScope({ sessionId: 'source', operationId: 'managed', callId: 'c', source: { sourceId: 'source' } }, () => true)
    const sink = await bridge.service.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('managed original'))
    const result = await sink.finish('complete'); if (result.kind !== 'committed') throw Error('Managed original unavailable')
    await bridge.service.grant({ sessionId: 'source' }, [result.ref.id], 'target')
    expect(callbacks).toBeGreaterThan(0)
    expect(refused.every(error => error instanceof Error && /reentry/.test(error.message))).toBe(true)
    await expect(coordinator.profile('nested-fresh')).rejects.toThrow()
  } finally { await bridge.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('blocks fresh target effects on actual consumed falsey lifetime uncertainty without reacquisition or no-op release proof', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-consumed-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract), bridge = serviceFor(root, coordinator, 'w')
  const opened = vi.spyOn(ContextStore.prototype, 'open'), nativeAcquire = locking.acquireSessionLock
  let releases = 0
  const paths: string[] = []
  try {
    const ref = (await bridge.service.capture(capture))!
    const acquire = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
      paths.push(options.lockPath)
      const original = await nativeAcquire(options)
      if (options.lockPath !== locking.lockPathFor(root, 'context-output-legacy:w')) return original
      return { get held() { return original.held }, async release() { releases++; await original.release(); throw null } }
    })
    await expect(bridge.service.read({ sessionId: 'denied' }, { refId: ref.id })).rejects.toThrow()
    const store = opened.mock.contexts[0] as ContextStore
    await expect(originalOwners.at(-1)!.pinOwnership('fresh')).rejects.toBe(null)
    const acquired = paths.length
    await expect(retryOriginalResultOrdering(coordinator)).rejects.toBe(null)
    expect(paths).toHaveLength(acquired); expect(releases).toBe(1); expect(store.lifetimeSettled()).toBe(false)
    expect(paths.some(path => path.startsWith(join(root, 'sessions')))).toBe(false)
    acquire.mockRestore()
  } finally { vi.restoreAllMocks(); await bridge.service.close().catch(() => {}); await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

it('fences actual dynamic service use until its original coordinator registration commits', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-dynamic-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract), bridge = serviceFor(root, coordinator, 'w', true)
  const opened = vi.spyOn(ContextStore.prototype, 'open')
  try {
    await expect(bridge.service.capture(capture)).rejects.toThrow(/registration required/)
    expect(opened).not.toHaveBeenCalled()
    bridge.registerCoordinator(coordinator)
    expect(await bridge.service.capture(capture)).toBeDefined()
    await coordinator.create({ sessionId: 'fresh' })
  } finally { opened.mockRestore(); await bridge.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses registration during original fresh acquisition before constructing a second service', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-registration-race-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract), bridge = serviceFor(root, coordinator, 'w')
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>(), quiesce = ContextStore.prototype.quiesce
  let delayed = false
  try {
    const ref = (await bridge.service.capture(capture))!
    await expect(bridge.service.read({ sessionId: 'denied' }, { refId: ref.id })).rejects.toThrow()
    const probe = vi.spyOn(ContextStore.prototype, 'quiesce').mockImplementation(async function (this: ContextStore, lease) { if (!delayed) { delayed = true; entered.resolve(); await leave.promise }; return quiesce.call(this, lease) })
    const creating = coordinator.create({ sessionId: 'fresh' }); await entered.promise
    let subscriptions = 0
    expect(() => createProcessAwareResultService({ root, workspaceId: 'second', orderingCoordinators: [coordinator], coordinatorFor: () => coordinator, sourceFor: async () => ({ sourceId: 'source' }), genericVisible: async () => false, documentDeletions() { subscriptions++; return () => {} } })).toThrow(/registration busy/)
    expect(subscriptions).toBe(0)
    leave.resolve(); await creating; probe.mockRestore()
  } finally { leave.resolve(); vi.restoreAllMocks(); await bridge.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('refuses legacy self-entry before a fresh session exists while allowing its exact healthy parent claim', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-self-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'parent' })
  const bridge = serviceFor(root, coordinator, 'w', false, async () => {
    await coordinator.adoptOwnership('parent')
    await expect(coordinator.create({ sessionId: 'nested-fresh' })).rejects.toThrow(/reentry/)
    return false
  })
  try {
    const ref = (await bridge.service.capture(capture))!
    await expect(bridge.service.read({ sessionId: 'denied' }, { refId: ref.id })).rejects.toThrow()
    await expect(coordinator.profile('nested-fresh')).rejects.toThrow()
  } finally { await bridge.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('preserves falsey prerequisite debt and closes only its original attempt before a fresh retry', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ordering-falsey-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract), bridge = serviceFor(root, coordinator, 'w')
  const opened = vi.spyOn(ContextStore.prototype, 'open')
  try {
    const ref = (await bridge.service.capture(capture))!
    await expect(bridge.service.read({ sessionId: 'denied' }, { refId: ref.id })).rejects.toThrow()
    const store = opened.mock.contexts[0] as ContextStore, acquire = vi.spyOn(store, 'acquireLifetime')
    const quiesce = vi.spyOn(store, 'quiesce').mockRejectedValueOnce(undefined)
    await expect(originalOwners.at(-1)!.pinOwnership('fresh')).rejects.toBeUndefined()
    expect(store.lifetimeSettled()).toBe(false)
    await expect(bridge.service.capture({ ...capture, callId: 'blocked' })).rejects.toThrow(/ordering in progress/)
    await retryOriginalResultOrdering(coordinator)
    expect(store.lifetimeSettled()).toBe(true); expect(acquire).not.toHaveBeenCalled()
    expect(quiesce).toHaveBeenCalledTimes(2)
    await coordinator.create({ sessionId: 'fresh' })
  } finally { vi.restoreAllMocks(); await bridge.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('joins BOTH configured original result-service lifetimes before the actual coordinator creates a fresh session', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'original-ordering-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  const opened = vi.spyOn(ContextStore.prototype, 'open')
  const bridges = ['one', 'two'].map(workspaceId => {
    const policy = { root, workspaceId, config: { enabled: true }, coordinatorFor: () => coordinator,
      orderingCoordinators: [coordinator], sourceFor: async () => ({ sourceId: 'source' }), genericVisible: async () => false, authorize: async () => false }
    return createProcessAwareResultService(policy)
  })
  try {
    for (const bridge of bridges) {
      const ref = (await bridge.service.capture({ sessionId: 'source', callId: 'c', label: 'c', text: 'original retained bytes', complete: true }))!
      await expect(bridge.service.read({ sessionId: 'denied' }, { refId: ref.id })).rejects.toThrow()
    }
    const stores = opened.mock.contexts as ContextStore[]
    expect(stores).toHaveLength(2)
    expect(stores.map(store => store.lifetimeSettled())).toEqual([false, false])
    await coordinator.create({ sessionId: 'fresh' })
    expect(stores.map(store => store.lifetimeSettled())).toEqual([true, true])
  } finally { opened.mockRestore(); for (const bridge of bridges) await bridge.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
