import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, createNondurableFactOwner } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createChildInstructionHost } from '../src/context/instructions/child-host.ts'
import { rmWorkspaceSync } from './helpers.ts'

const seams = vi.hoisted(() => ({ stage: '' as string, fault: undefined as unknown, hold: undefined as Promise<void> | undefined,
  runtimeCloses: 0, managerCloses: 0, runtimes: 0, managers: 0, order: [] as string[] }))
vi.mock('@i-harness/runtime-context', async original => {
  const api = await original<typeof import('@i-harness/runtime-context')>()
  return { ...api, createRuntimeContext(...args: Parameters<typeof api.createRuntimeContext>) {
    if (seams.stage === 'runtime') throw seams.fault
    const runtime = api.createRuntimeContext(...args); seams.runtimes++
    return { ...runtime, registerSection(...section: Parameters<typeof runtime.registerSection>) {
      const result = runtime.registerSection(...section)
      if (seams.stage === 'section') throw seams.fault
      return result
    }, async close() { seams.runtimeCloses++; seams.order.push('runtime'); await seams.hold; await runtime.close() } }
  } }
})
vi.mock('../src/context/instructions/manager.ts', async original => {
  const api = await original<typeof import('../src/context/instructions/manager.ts')>()
  return { ...api, createMainInstructionManager(...args: Parameters<typeof api.createMainInstructionManager>) {
    if (seams.stage === 'manager') throw seams.fault
    const manager = api.createMainInstructionManager(...args); seams.managers++
    return { ...manager, async close() { seams.managerCloses++; seams.order.push('manager'); await manager.close() } }
  } }
})
afterEach(() => { seams.stage = ''; seams.fault = undefined; seams.hold = undefined; seams.runtimeCloses = 0; seams.managerCloses = 0; seams.runtimes = 0; seams.managers = 0; seams.order = [] })

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'ic-f-')); await writeFile(join(cwd, 'AGENTS.md'), 'FACTORY_CURRENT_RULE')
  const environment = createProjectInstructionEnvironment(), session = createSession(), owner = createNondurableFactOwner(session)
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, publish: async () => {} })
  const host = createChildInstructionHost({ ...options, root: { session, factOwner: owner, manager } })
  const child = createSession(), factOwner = createNondurableFactOwner(child)
  return { ...options, host, child, factOwner, manager, input: { session: child, factOwner, lifetime: { available: () => true } }, async close() {
    seams.stage = ''; seams.hold = undefined; await host.close(); await manager.close(); await environment.close(); rmWorkspaceSync(cwd)
  } }
}

it('constructs a minimal lease with no reads, actions or inherited publication; exact owner and duplicate views are checked', async () => {
  const f = await fixture(), create = vi.spyOn(f.environment.host, 'create'), action = vi.spyOn(f.factOwner, 'beginAction')
  try {
    const lease = f.host.create(f.input)
    expect(Object.keys(lease).sort()).toEqual(['close', 'requestContext', 'retire', 'settleOriginals'])
    expect(create).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled(); expect(f.child.events).toEqual([])
    expect(() => f.host.create(f.input)).toThrow()
    expect(() => f.host.create({ ...f.input, factOwner: createNondurableFactOwner(createSession()) })).toThrow()
    await lease.requestContext.reconcile()
    expect(f.child.events.findLast(event => event.type === 'runtime/context')).toMatchObject({ sections: [{ name: 'instructions', text: expect.stringContaining('FACTORY_CURRENT_RULE') }] })
    expect(f.manager.capture()).toBeUndefined()
    await lease.close()
  } finally { await f.close() }
})

it.each(['runtime', 'manager', 'section'])('synchronously reports original %s setup faults including undefined and permits retry after original cleanup acknowledgment', async stage => {
  const f = await fixture()
  try {
    for (const fault of [undefined, null, Error('original setup fault')]) {
      seams.stage = stage; seams.fault = fault
      const gate = Promise.withResolvers<void>(); seams.hold = gate.promise
      let thrown = false, caught: unknown = Symbol('not thrown')
      try { f.host.create(f.input) } catch (error) { thrown = true; caught = error }
      expect(thrown).toBe(true); expect(caught).toBe(fault)
      seams.stage = ''
      expect(() => f.host.create(f.input)).toThrow()
      gate.resolve(); seams.stage = ''; seams.hold = undefined
      // Deferred construction cleanup must finish without shutting down host.
      await new Promise(resolve => setImmediate(resolve))
      const lease = f.host.create(f.input); await lease.close()
    }
    await expect(f.host.close()).resolves.toBeUndefined()
    for (let index = 0; index < seams.order.length; index++) if (seams.order[index] === 'manager') expect(seams.order[index - 1]).toBe('runtime')
  } finally { await f.close() }
})

it('reserves before supplied availability and refuses synchronous reentrant create and close without self join', async () => {
  const f = await fixture(); let nested = false, localClose: Promise<void> | undefined
  try {
    expect(() => f.host.create({ ...f.input, lifetime: { available() {
      if (!nested) { nested = true; expect(() => f.host.create(f.input)).toThrow(); localClose = f.host.close() }
      return true
    } } })).toThrow()
    await expect(localClose).rejects.toThrow(/reentrant/i)
    await expect(f.host.close()).resolves.toBeUndefined()
    expect(seams.runtimes).toBe(0)
  } finally { await f.close() }
})

it('uses the actual managed FactOwner and rejects an exact-view forged owner without actions', async () => {
  const f = await fixture(), coordinator = createSessionCoordinator(createJsonlBackend(join(f.cwd, 'sessions')), { lock: { enabled: true } })
  try {
    const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
    expect(() => f.host.create({ session: document.view, factOwner: { ...document }, lifetime: { available: () => true } })).toThrow()
    const before = document.view.events.length
    const lease = f.host.create({ session: document.view, factOwner: document, lifetime: { available: () => true } })
    expect(document.view.events).toHaveLength(before)
    await lease.requestContext.reconcile()
    expect(document.view.events.findLast(event => event.type === 'runtime/context')).toBeDefined()
    await lease.close(); await document.close()
  } finally { await f.close(); await coordinator.close() }
})

it('rejects a mismatched borrowed root, root-as-child and immutable foreign views before allocating child resources', async () => {
  const f = await fixture()
  try {
    expect(() => createChildInstructionHost({ ...f, root: { session: f.child, factOwner: createNondurableFactOwner(createSession()), manager: f.manager } })).toThrow()
    const root = createSession(), owner = createNondurableFactOwner(root)
    const host = createChildInstructionHost({ ...f, root: { session: root, factOwner: owner, manager: f.manager } })
    expect(() => host.create({ session: root, factOwner: owner, lifetime: { available: () => true } })).toThrow()
    const foreign = Object.freeze({ ...f.child })
    expect(() => host.create({ session: foreign, factOwner: { ...f.factOwner, view: foreign }, lifetime: { available: () => true } })).toThrow()
    expect(seams.runtimes).toBe(0); await host.close()
  } finally { await f.close() }
})

it('captures the original input identities so later mutable aliases cannot strand an acknowledged original slot', async () => {
  const f = await fixture(), input = { ...f.input }, other = createSession(), otherOwner = createNondurableFactOwner(other)
  const create = vi.spyOn(f.environment.host, 'create'), action = vi.spyOn(f.factOwner, 'beginAction')
  try {
    const lease = f.host.create(input)
    input.session = other; input.factOwner = otherOwner
    expect(create).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled()
    await lease.close()
    expect(seams.runtimeCloses).toBe(1); expect(seams.managerCloses).toBe(1)
    const replacement = f.host.create(f.input)
    expect(seams.runtimes).toBe(2); expect(create).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled()
    await replacement.close()
  } finally { await f.close() }
})

it('captures original input before availability can redirect actual runtime publication to a different view and owner', async () => {
  const f = await fixture(), other = createSession(), otherOwner = createNondurableFactOwner(other)
  const input = { ...f.input, lifetime: { available() { input.session = other; input.factOwner = otherOwner; return true } } }
  const create = vi.spyOn(f.environment.host, 'create'), originalAction = vi.spyOn(f.factOwner, 'beginAction'), otherAction = vi.spyOn(otherOwner, 'beginAction')
  try {
    const lease = f.host.create(input)
    expect(create).not.toHaveBeenCalled(); expect(originalAction).not.toHaveBeenCalled(); expect(otherAction).not.toHaveBeenCalled()
    expect(seams.runtimes).toBe(1)
    await lease.requestContext.reconcile()
    expect(f.child.events.findLast(event => event.type === 'runtime/context')).toMatchObject({ sections: [{ name: 'instructions', text: expect.stringContaining('FACTORY_CURRENT_RULE') }] })
    expect(other.events).toEqual([]); expect(originalAction).toHaveBeenCalledTimes(1); expect(otherAction).not.toHaveBeenCalled()
    await lease.close()
    const replacement = f.host.create(f.input); await replacement.close()
  } finally { await f.close() }
})

it.each(['method', 'lifetime'] as const)('captures original lifetime method and receiver while %s substitution cannot replace its live predicate', async substitution => {
  const f = await fixture(), lifetime = { live: true, available() { return this.live } }, input = { ...f.input, lifetime }
  try {
    const lease = f.host.create(input)
    await lease.requestContext.reconcile()
    if (substitution === 'method') lifetime.available = () => false
    else input.lifetime = { live: false, available: () => false }
    // Original function still runs with its original receiver and live state.
    await expect(lease.requestContext.reconcile()).resolves.toBeUndefined()
    lifetime.live = false
    lifetime.available = () => true; input.lifetime = { live: true, available: () => true }
    expect(lease.requestContext.capture()).toBeUndefined()
    await expect(lease.requestContext.reconcile()).rejects.toMatchObject({ code: 'CONTEXT_INPUT_STALE' })
    lifetime.live = true; await lease.requestContext.reconcile()
    await lease.close()
  } finally { await f.close() }
})

it('a lifetime capability getter reentering host close cannot allocate after the retirement fence', async () => {
  const f = await fixture(); let local: Promise<void> | undefined, predicateCalls = 0
  try {
    const lifetime = { get available() { local = f.host.close(); return () => { predicateCalls++; return true } } }
    expect(() => f.host.create({ ...f.input, lifetime })).toThrow()
    await expect(local).rejects.toThrow(/reentrant/i)
    expect(predicateCalls).toBe(0)
    expect(seams.runtimes).toBe(0)
    await expect(f.host.close()).resolves.toBeUndefined()
  } finally { await f.close() }
})
