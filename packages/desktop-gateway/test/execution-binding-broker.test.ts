import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createSessionManagementFence } from '../src/session-management-fence.ts'

it('admits a genuine cold absent binding and retires it on a failed fence preflight', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-observe-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 })
  const fence = createSessionManagementFence()
  const broker = createProjectScopeBroker(coordinator, root, undefined, { fence })
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    let retired = 0
    const observation = broker.observeExecutionBinding(ref, operation => { retired++; return ref.release(operation) })
    observation.assertCurrent()
    await expect(fence.exclusive('s', async () => {}, async () => { throw Error('preflight') })).rejects.toThrow('preflight')
    expect(retired).toBe(1)
    expect(() => observation.assertCurrent()).toThrow()
    observation.release()
  } finally { await broker.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})


it('rejects foreign and cloned references and applies the actual conversation policy', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-policy-'))
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const coordinator = createSessionCoordinator(createJsonlBackend(root), options)
  const foreign = createSessionCoordinator(createJsonlBackend(root), options)
  const broker = createProjectScopeBroker(coordinator, root)
  try {
    for (const [id, origin, parentSession, accepted] of [
      ['root', undefined, undefined, true], ['fork', 'fork', 'root', true],
      ['team', 'team', undefined, true], ['child', 'subagent', 'root', false],
      ['review', 'approval-review', 'root', false], ['team-child', 'team', 'root', false],
    ] as const) {
      await coordinator.create({ sessionId: id, origin, parentSession }); await coordinator.releaseOwnership(id)
      const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: id }, () => {})
      if (accepted) { const observation = broker.observeExecutionBinding(ref, () => {}); observation.assertCurrent(); observation.release() }
      else expect(() => broker.observeExecutionBinding(ref, () => {})).toThrow()
      expect(() => broker.observeExecutionBinding({ ...ref }, () => {})).toThrow()
      await ref.release()
    }
    const foreignRef = await foreign.retainExistingSessionBindingObservation!({ sessionId: 'root' }, () => {})
    expect(() => broker.observeExecutionBinding(foreignRef, () => {})).toThrow()
    await foreignRef.release()
  } finally { await broker.close(); await coordinator.close(); await foreign.close(); await rm(root, { recursive: true, force: true }) }
})

it('bounds broker observers and retains a slot while fence cleanup is pending', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-bound-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 })
  const fence = createSessionManagementFence(), broker = createProjectScopeBroker(coordinator, root, undefined, { fence })
  const gate = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    const observations = Array.from({ length: 32 }, () => broker.observeExecutionBinding(ref, () => gate.promise))
    expect(() => broker.observeExecutionBinding(ref, () => {})).toThrow(/capacity/)
    const retiring = fence.exclusive('s', async () => {}, async () => { throw Error('preflight') })
    expect(() => observations[0]!.assertCurrent()).toThrow()
    expect(() => broker.observeExecutionBinding(ref, () => {})).toThrow(/capacity/)
    gate.resolve(); await expect(retiring).rejects.toThrow('preflight')
    const nextRef = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    const fresh = broker.observeExecutionBinding(nextRef, () => {}); fresh.release(); await nextRef.release()
    await ref.release()
  } finally { gate.resolve(); await broker.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('admits a cold own-bound capture and holds the original native lock', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-lock-'))
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const coordinator = createSessionCoordinator(createJsonlBackend(root), options), other = createSessionCoordinator(createJsonlBackend(root), options)
  const writer = createProjectScopeBroker(coordinator, root), reader = createProjectScopeBroker(coordinator, root)
  try {
    await coordinator.create({ sessionId: 's' })
    await writer.configure({ id: 'p', name: 'P', roots: [root], primaryRoot: root })
    await writer.bind('s', 'p'); await coordinator.releaseOwnership('s')
    await reader.configure({ id: 'p', name: 'P', roots: [root], primaryRoot: root })
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    const observation = reader.observeExecutionBinding(ref, () => {})
    observation.assertCurrent()
    await expect(other.adoptOwnership('s')).rejects.toThrow()
    observation.release(); await ref.release()
    await other.adoptOwnership('s'); await other.releaseOwnership('s')
  } finally { await writer.close(); await reader.close(); await coordinator.close(); await other.close(); await rm(root, { recursive: true, force: true }) }
})

it('broker admission releases a forgetful inspector before a held authority callback', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-eager-'))
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const coordinator = createSessionCoordinator(createJsonlBackend(root), options), other = createSessionCoordinator(createJsonlBackend(root), options)
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const broker = createProjectScopeBroker(coordinator, root, undefined, { authorityChanged: async () => { entered.resolve(); await gate.promise } })
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    await broker.forSession('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    let retired = 0
    const observation = broker.observeExecutionBinding(ref, () => { retired++ })
    const changing = broker.configureReferences([])
    expect(retired).toBe(1)
    expect(() => observation.assertCurrent()).toThrow()
    await entered.promise
    await other.adoptOwnership('s'); await other.releaseOwnership('s')
    gate.resolve(); await changing
  } finally { gate.resolve(); await broker.close(); await coordinator.close(); await other.close(); await rm(root, { recursive: true, force: true }) }
})

it('fence self-reentry refuses before blocking or retiring an active retained read', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-self-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  const fence = createSessionManagementFence(), broker = createProjectScopeBroker(coordinator, root, undefined, { fence })
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    const observation = broker.observeExecutionBinding(ref, () => {})
    await ref.withRead(async () => {
      await expect(fence.exclusive('s', async () => {})).rejects.toThrow()
      fence.assertOpen('s'); observation.assertCurrent()
      await expect(broker.close()).rejects.toThrow()
      observation.assertCurrent()
    })
    observation.release(); await ref.release()
  } finally { await broker.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['bind', 'configure', 'sync', 'revoke', 'move', 'inherit', 'close'] as const)('retires on %s admission even when the request fails or is unchanged', async action => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-admission-'))
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const coordinator = createSessionCoordinator(createJsonlBackend(root), options), other = createSessionCoordinator(createJsonlBackend(root), options)
  const broker = createProjectScopeBroker(coordinator, root)
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    let retired = 0
    const observed = broker.observeExecutionBinding(ref, () => { retired++ })
    const mutation = action === 'bind' ? broker.bind('s', 'missing') : action === 'configure' ? broker.configure({}) : action === 'sync' ? broker.sync([]) : action === 'revoke' ? broker.revoke('missing') : action === 'move' ? broker.move('s', undefined, undefined) : action === 'inherit' ? broker.inherit('missing', 's') : broker.close()
    expect(retired).toBe(1); expect(() => observed.assertCurrent()).toThrow()
    await mutation.catch(() => {})
    await other.adoptOwnership('s'); await other.releaseOwnership('s')
  } finally { await broker.close(); await coordinator.close(); await other.close(); await rm(root, { recursive: true, force: true }) }
})

it('a throwing sink cannot prevent independent native cleanup or later observers retirement', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-throw-'))
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const coordinator = createSessionCoordinator(createJsonlBackend(root), options), other = createSessionCoordinator(createJsonlBackend(root), options)
  const broker = createProjectScopeBroker(coordinator, root)
  try {
    for (const id of ['s', 't']) { await coordinator.create({ sessionId: id }); await coordinator.releaseOwnership(id) }
    const first = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    const second = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 't' }, () => {})
    const a = broker.observeExecutionBinding(first, () => { throw false })
    let retired = 0
    const b = broker.observeExecutionBinding(second, () => { retired++ })
    await expect(broker.configureReferences([])).rejects.toBe(false)
    expect(retired).toBe(1); expect(() => a.assertCurrent()).toThrow(); expect(() => b.assertCurrent()).toThrow()
    for (const id of ['s', 't']) { await other.adoptOwnership(id); await other.releaseOwnership(id) }
  } finally { await broker.close(); await coordinator.close(); await other.close(); await rm(root, { recursive: true, force: true }) }
})

it('original coordinator metadata retirement eagerly closes the broker observer', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-original-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  const broker = createProjectScopeBroker(coordinator, root)
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    let retired = 0
    const observed = broker.observeExecutionBinding(ref, () => { retired++ })
    await coordinator.releaseOwnership('s')
    expect(retired).toBe(1); expect(() => observed.assertCurrent()).toThrow()
  } finally { await broker.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('coordinator retirement joins the broker sink under its still-active cleanup token', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-token-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  const broker = createProjectScopeBroker(coordinator, root), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    broker.observeExecutionBinding(ref, async operation => { entered.resolve(); await gate.promise; await ref.release(operation) })
    let settled = false
    const retiring = coordinator.releaseOwnership('s').then(() => { settled = true })
    await entered.promise; await Promise.resolve(); expect(settled).toBe(false)
    gate.resolve(); await retiring
  } finally { gate.resolve(); await broker.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('retirement callback reentry into broker close joins cleanup without a cycle', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-reentry-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  const broker = createProjectScopeBroker(coordinator, root)
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    broker.observeExecutionBinding(ref, () => broker.close())
    await broker.close()
  } finally { await broker.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('explicit token release joins original-reference observer sinks before host fallback can finish', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'broker-host-token-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  const broker = createProjectScopeBroker(coordinator, root), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const { createRetainedCleanupOperation, finishRetainedCleanupOperation, closeCoordinatorWithRetainedCleanupOperation } = await import('@i-harness/session-persistence/internal/retained-inspection')
  const operation = createRetainedCleanupOperation()
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    broker.observeExecutionBinding(ref, async token => { expect(token).toBe(operation); entered.resolve(); await gate.promise; await ref.release(token) })
    let settled = false
    const releasing = ref.release(operation).then(() => { settled = true })
    await entered.promise; await Promise.resolve(); expect(settled).toBe(false)
    gate.resolve(); await releasing; await closeCoordinatorWithRetainedCleanupOperation(coordinator, operation)
  } finally { gate.resolve(); finishRetainedCleanupOperation(operation); await broker.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
