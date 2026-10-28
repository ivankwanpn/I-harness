import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator } from '../src/index.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createMutations } from '../src/coordinator/mutations.ts'
import { createLoads } from '../src/coordinator/load.ts'
import { createManagedDocuments } from '../src/coordinator/managed-documents.ts'
import { createManagedDocument, captureManagedParentReadiness, captureManagedReadyObservation } from '../src/coordinator/managed-document.ts'

it('captures the original ready registry parent across event growth and fences replacement and revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-parent-')), backend = createJsonlBackend(root), opts = { lock: { enabled: true } }
  const initial = createSessionCoordinator(backend, opts)
  await initial.create({ sessionId: 'parent' }); await initial.close()
  const ownership = createOwnership(backend, opts), mutations = createMutations(backend, ownership, 200, () => {})
  const loads = createLoads(backend, ownership, mutations), registry = createManagedDocuments(backend, ownership, loads.loadOwned, opts, () => {}, mutations)
  try {
    const document = await registry.open('parent'), strict = captureManagedReadyObservation(document, ownership)
    const source = await loads.loadOwned('parent')
    const unready = createManagedDocument('parent', source.session, strict.prefix, backend, ownership, opts, () => {}, { operationId: 'pending', bind() {} })
    expect(() => captureManagedParentReadiness(unready, ownership)).toThrow()
    const parent = registry.captureParent(document)
    expect(Object.isFrozen(parent)).toBe(true); parent.assertCurrent()
    expect(() => parent.assertCurrent.call({})).toThrow()
    const foreign = createOwnership(backend, opts)
    expect(() => captureManagedParentReadiness(document, foreign)).toThrow()
    const other = createManagedDocuments(backend, foreign, loads.loadOwned, opts, () => {}, mutations)
    expect(() => other.captureParent(document)).toThrow()
    expect(() => registry.captureParent({ ...document })).toThrow()
    expect(() => registry.captureParent(new Proxy(document, {}))).toThrow()
    expect((await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
    parent.assertCurrent(); expect(() => strict.assertCurrent()).toThrow()
    const original = document.assertReady; let calls = 0
    document.assertReady = () => { calls++ }
    expect(() => parent.assertCurrent()).toThrow(); expect(() => registry.captureParent(document)).toThrow(); expect(calls).toBe(0)
    Object.defineProperty(document, 'assertReady', { configurable: true, get() { calls++; return original } })
    expect(() => parent.assertCurrent()).toThrow(); expect(calls).toBe(0)
    Object.defineProperty(document, 'assertReady', { configurable: true, writable: true, value: original })
    const view = document.view
    Object.defineProperty(document, 'view', { configurable: true, writable: true, value: {} })
    expect(() => parent.assertCurrent()).toThrow()
    Object.defineProperty(document, 'view', { configurable: true, get() { calls++; return view } })
    expect(() => parent.assertCurrent()).toThrow(); expect(calls).toBe(0)
    Object.defineProperty(document, 'view', { configurable: true, writable: true, value: view })
    parent.assertCurrent()
    registry.revoke('parent'); expect(() => parent.assertCurrent()).toThrow()
    await registry.closeOne('parent'); expect(() => parent.assertCurrent()).toThrow()
    expect(() => registry.captureParent(document)).toThrow()
  } finally { await registry.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true }) }
})



