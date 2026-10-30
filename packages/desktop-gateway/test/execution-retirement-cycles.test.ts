import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { observeRetainedBindingRetirementFor, closeCoordinatorWithRetainedCleanupOperation, joinRetainedRetirementSinks } from '@i-harness/session-persistence/internal/retained-inspection'

it.each(['direct', 'async', 'then', 'delayed'] as const)('refuses %s full broker close from its active sink and completes native disposal', async shape => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'sink-cycle-'))
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const coordinator = createSessionCoordinator(createJsonlBackend(root), options), other = createSessionCoordinator(createJsonlBackend(root), options)
  const broker = createProjectScopeBroker(coordinator, root)
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    broker.observeExecutionBinding(ref, () => shape === 'direct' ? broker.close() : shape === 'then' ? broker.close().then(() => {}) : shape === 'async' ? (async () => { await broker.close() })() : (async () => { await Promise.resolve(); await broker.close() })())
    await expect(broker.close()).rejects.toThrow(/retirement sink/i)
    await other.adoptOwnership('s'); await other.releaseOwnership('s')
    await broker.close()
  } finally { await coordinator.close(); await other.close(); await rm(root, { recursive: true, force: true }) }
}, 1500)

it('refuses delayed same-token full coordinator close in a private listener before effects', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'private-cycle-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    observeRetainedBindingRetirementFor(coordinator, ref, async operation => {
      await Promise.resolve()
      await expect(closeCoordinatorWithRetainedCleanupOperation(coordinator, operation)).rejects.toThrow(/retirement sink/i)
      await expect(joinRetainedRetirementSinks(operation)).rejects.toThrow(/retirement sink/i)
      await ref.release(operation)
      throw false
    })
    let failure: unknown
    try { await coordinator.close() } catch (error) { failure = error }
    const flatten = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error]
    expect(flatten(failure)).toContain(false)
    await coordinator.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 1500)
import { createSessionManagementFence } from '../src/session-management-fence.ts'

it.each(['return', 'undefined', 'ignored-profile'] as const)('read-time guard retirement drains %s before notification and native disposal', async outcome => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'read-retirement-'))
  const backend = createJsonlBackend(root), originalProfile = backend.profile.bind(backend)
  const profileEntered = Promise.withResolvers<void>(), profileGate = Promise.withResolvers<void>()
  let holdProfile = false
  backend.profile = async id => { if (holdProfile && id === 't') { profileEntered.resolve(); await profileGate.promise }; return originalProfile(id) }
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const coordinator = createSessionCoordinator(backend, options), other = createSessionCoordinator(createJsonlBackend(root), options)
  const fence = createSessionManagementFence(), observe = fence.observe.bind(fence)
  let failGuard = false
  fence.observe = (...args) => { const original = observe(...args); return { ...original, assertCurrent() { original.assertCurrent(); if (failGuard && args[0] === 't') throw Error('actual retained read guard failed') } } }
  const bindEntered = Promise.withResolvers<void>(), bindGate = Promise.withResolvers<void>(), trigger = Promise.withResolvers<void>(), readEntered = Promise.withResolvers<void>(), notified = Promise.withResolvers<void>()
  const broker = createProjectScopeBroker(coordinator, root, async id => { if (id === 's') { bindEntered.resolve(); await bindGate.promise }; return true }, { fence })
  let retired = 0
  try {
    for (const id of ['s', 't']) { await coordinator.create({ sessionId: id }); await coordinator.releaseOwnership(id) }
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 't' }, () => {})
    const observed = broker.observeExecutionBinding(ref, () => { retired++; notified.resolve() })
    holdProfile = outcome === 'ignored-profile'
    const read = ref.withRead(async profile => {
      if (holdProfile) { void profile().catch(() => {}); await profileEntered.promise }
      readEntered.resolve(); await trigger.promise
      expect(() => observed.assertCurrent()).toThrow('actual retained read guard failed')
      expect(() => ref.assertCurrent()).toThrow()
      expect(retired).toBe(0)
      if (outcome === 'undefined') throw undefined
      return 1
    })
    void read.catch(() => {})
    await readEntered.promise
    const binding = broker.bind('s'); void binding.catch(() => {}); await bindEntered.promise
    failGuard = true; trigger.resolve()
    if (holdProfile) {
      await new Promise(resolve => setImmediate(resolve)); expect(retired).toBe(0)
      observed.release() // terminal consumer disposal must leave debt reachable
      await expect(other.adoptOwnership('t')).rejects.toThrow()
      profileGate.resolve()
    }
    if (outcome === 'undefined') await expect(read).rejects.toBeUndefined()
    else await expect(read).rejects.toThrow()
    await notified.promise
    await other.adoptOwnership('t'); await other.releaseOwnership('t')
    bindGate.resolve(); await binding
    failGuard = false
    const fresh = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 't' }, () => {})
    const observers = Array.from({ length: 32 }, () => broker.observeExecutionBinding(fresh, () => {}))
    observers.forEach(observer => observer.release()); await fresh.release()
  } finally { trigger.resolve(); profileGate.resolve(); bindGate.resolve(); await broker.close(); await coordinator.close(); await other.close(); await rm(root, { recursive: true, force: true }) }
}, 3000)

it('caught sink conflict permits a full external close and stale sink descendants expire', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'sink-expiry-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  const broker = createProjectScopeBroker(coordinator, root), gate = Promise.withResolvers<void>()
  let detached: Promise<void> | undefined
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    broker.observeExecutionBinding(ref, async operation => {
      await expect(broker.close()).rejects.toThrow(/retirement sink/i)
      await ref.release(operation)
      detached = gate.promise.then(() => broker.close())
    })
    const first = broker.close(), concurrent = broker.close()
    expect(first).toBe(concurrent); await first
    gate.resolve(); await detached
  } finally { gate.resolve(); await broker.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([undefined, null, false, 0, ''])('preserves literal sink rejection %s while independent native disposal finishes', async failure => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'sink-falsey-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  const broker = createProjectScopeBroker(coordinator, root)
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    broker.observeExecutionBinding(ref, () => { throw failure })
    await expect(broker.close()).rejects.toBe(failure)
    await broker.close()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('fence sink refuses same-domain lifecycle reentry before touching another session', async () => {
  const fence = createSessionManagementFence()
  fence.observe('s', async () => {
    await Promise.resolve()
    expect(() => fence.retire('other')).toThrow(/retirement sink/i)
    await expect(fence.exclusive('other', async () => {})).rejects.toThrow(/retirement sink/i)
  })
  await fence.exclusive('s', async () => {})
  fence.assertOpen('other')
})
