import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { coldLegacyFixture } from '../../context-output/test/fixtures/cold-selected-legacy.ts'
import * as bindings from '../../session-persistence/src/coordinator/binding-observation.ts'
import { beginColdSelectedFinalization, inspectColdSelectedTarget } from '../../session-persistence/src/selected-source-owner.ts'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createSessionManagementFence } from '../src/session-management-fence.ts'
import type { BootstrapProjectIntent } from '../../session-persistence/src/coordinator/bootstrap-intent.ts'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'

const absentBinding = Symbol('absent binding')
async function policyFixture(project: BootstrapProjectIntent = { kind: 'unassigned' }, binding: unknown = { version: 1 }, visible?: () => Promise<boolean>) {
  let broker!: ReturnType<typeof createProjectScopeBroker>, policy!: ReturnType<ReturnType<typeof createProjectScopeBroker>['acquireColdTargetPolicy']>
  const original = bindings.createBindingObservations
  const injection = vi.spyOn(bindings, 'createBindingObservations').mockImplementation((...args) => {
    const owner = original(...args), make = owner.createColdFinalizationFactory
    owner.createColdFinalizationFactory = bootstrap => make(bootstrap, { begin(cold, actual) { policy = broker.acquireColdTargetPolicy(cold, actual); return policy } }); return owner
  })
  const f = await coldLegacyFixture(true, project); injection.mockRestore()
  const fence = createSessionManagementFence()
  if (binding !== absentBinding) await f.coordinator.putDocumentStrict!('desktop-session-project-' + createHash('sha256').update('target').digest('hex'), binding)
  broker = createProjectScopeBroker(f.coordinator, f.root, visible, { fence })
  const handles: ReturnType<typeof beginColdSelectedFinalization>[] = []
  return { ...f, broker, fence, get policy() { return policy }, async begin() {
    const target = await inspectColdSelectedTarget(f.coordinator, f.route); if (target.kind !== 'qualification-required') throw Error('Missing target')
    const handle = beginColdSelectedFinalization(f.coordinator, target.target); handles.push(handle); return handle
  }, async close() { injection.mockRestore(); for (const handle of handles) await handle.close(); await broker.close(); await f.close() } }
}

it('qualifies target-only original broker policy and seals it independently of expired F0 callbacks', async () => {
  let broker: any, policy: any
  const original = bindings.createBindingObservations
  // Private leaf integration only: the real finite owner issues the actual F0;
  // no READY commit or production qualifier installation occurs in this test.
  const injection = vi.spyOn(bindings, 'createBindingObservations').mockImplementation((...args) => {
    const owner = original(...args), make = owner.createColdFinalizationFactory
    owner.createColdFinalizationFactory = bootstrap => make(bootstrap, { begin(cold, binding) {
      policy = broker.acquireColdTargetPolicy(cold, binding)
      expect(() => broker.acquireColdTargetPolicy(cold, { ...binding })).toThrow()
      expect(() => broker.acquireColdTargetPolicy({ ...cold }, binding)).toThrow()
      return policy
    } }); return owner
  })
  const f = await coldLegacyFixture(true, { kind: 'unassigned' }); injection.mockRestore()
  let handle: ReturnType<typeof beginColdSelectedFinalization> | undefined
  try {
    const key = 'desktop-session-project-' + createHash('sha256').update('target').digest('hex')
    await f.coordinator.putDocumentStrict!(key, { version: 1 })
    broker = createProjectScopeBroker(f.coordinator, f.root)
    expect(typeof broker.acquireColdTargetPolicy).toBe('function')
    const profile = vi.spyOn(f.coordinator, 'profile').mockImplementation(async () => { throw Error('Cold profile forbidden') })
    const documents = vi.spyOn(f.coordinator, 'getDocument').mockImplementation(async () => { throw Error('Cold generic document lookup forbidden') })
    try {
      const target = await inspectColdSelectedTarget(f.coordinator, f.route); if (target.kind !== 'qualification-required') throw Error('Missing target')
      handle = beginColdSelectedFinalization(f.coordinator, target.target); await handle.use(); await handle.settle()
      policy.assertSettledCurrent(); expect(policy.targetScope()).toMatchObject({ revision: expect.any(String) })
      expect(profile).not.toHaveBeenCalled(); expect(documents).not.toHaveBeenCalled()
      await broker.configureReferences([]); expect(() => policy.assertSettledCurrent()).toThrow()
      expect(() => handle!.commitReady()).toThrow(); await handle.close()
    } finally { profile.mockRestore(); documents.mockRestore() }
  } finally { injection.mockRestore(); await handle?.close(); await broker?.close(); await f.close() }
})

it.each(['absent', 'mismatch', 'malformed'] as const)('cold policy refuses %s own binding without inherited lookup, repair or source access', async mode => {
  const saved = mode === 'absent' ? absentBinding : mode === 'mismatch' ? { version: 1, projectId: 'foreign' } : { version: 1, inherited: 'source' }
  const f = await policyFixture({ kind: 'unassigned' }, saved)
  const profile = vi.spyOn(f.coordinator, 'profile'), put = vi.spyOn(f.coordinator as typeof f.coordinator & { putDocumentStrict: NonNullable<typeof f.coordinator.putDocumentStrict> }, 'putDocumentStrict'), get = vi.spyOn(f.coordinator, 'getDocument')
  try {
    const handle = await f.begin(); await expect(handle.use()).rejects.toThrow(/binding/)
    expect(() => f.policy.assertSettledCurrent()).toThrow(); for (const spy of [profile, put, get]) expect(spy).not.toHaveBeenCalled()
  } finally { profile.mockRestore(); put.mockRestore(); get.mockRestore(); await f.close() }
})

it('cold policy captures the current target project and terminally rejects synchronous catalogue ABA', async () => {
  const f = await policyFixture({ kind: 'project', projectId: 'p' }, { version: 1, projectId: 'p' })
  try {
    const project = { id: 'p', name: 'Target project', roots: [f.root], primaryRoot: f.root }
    await f.broker.configure(project)
    const handle = await f.begin(); await handle.use(); await handle.settle()
    expect(f.policy.targetScope()).toMatchObject({ projectId: 'p', scope: { id: 'p', roots: [await realpath(f.root)] } })
    f.policy.assertSettledCurrent()
    const change = f.broker.configure(project); expect(() => f.policy.assertSettledCurrent()).toThrow(); await change
    await f.broker.configure(project); expect(() => f.policy.assertSettledCurrent()).toThrow()
  } finally { await f.close() }
})

it('cold policy refuses self broker and management mutation before effects and detects settled management ABA', async () => {
  let f!: Awaited<ReturnType<typeof policyFixture>>, effects = 0
  f = await policyFixture({ kind: 'unassigned' }, { version: 1 }, async () => {
    await expect(f.broker.configureReferences([])).rejects.toThrow('self-mutation')
    await expect(f.fence.exclusive('target', async () => { effects++ })).rejects.toThrow('self-mutation')
    return true
  })
  try {
    const handle = await f.begin(); await handle.use(); await handle.settle(); expect(effects).toBe(0); f.policy.assertSettledCurrent()
    const mutation = f.fence.exclusive('target', async () => {}); expect(() => f.policy.assertSettledCurrent()).toThrow(); await mutation
    expect(() => f.policy.assertSettledCurrent()).toThrow()
  } finally { await f.close() }
})

it('cold policy fences pending external revocation and fails unknown roots or references without source fallback', async () => {
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  const f = await policyFixture({ kind: 'unassigned' }, { version: 1 }, async () => { entered.resolve(); await leave.promise; return true })
  try {
    const handle = await f.begin(), using = handle.use().then(() => undefined, error => error); await entered.promise
    const mutation = f.broker.configureReferences([]); expect(() => f.policy.targetScope()).toThrow(); leave.resolve(); await mutation
    expect(await using).toBeInstanceOf(Error); expect(() => f.policy.sealWhileActive()).toThrow()
  } finally { leave.resolve(); await f.close() }
  const unavailable = await policyFixture({ kind: 'project', projectId: 'p' }, { version: 1, projectId: 'p' })
  try {
    await expect(unavailable.broker.configure({ id: 'p', name: 'Missing', roots: [join(unavailable.root, 'missing')], primaryRoot: join(unavailable.root, 'missing') })).rejects.toThrow()
    const handle = await unavailable.begin(); await expect(handle.use()).rejects.toThrow()
  } finally { await unavailable.close() }
  const reference = await policyFixture()
  try {
    await expect(reference.broker.configureReferences([join(reference.root, 'missing')])).rejects.toThrow()
    const handle = await reference.begin(); await expect(handle.use()).rejects.toThrow()
  } finally { await reference.close() }
})
