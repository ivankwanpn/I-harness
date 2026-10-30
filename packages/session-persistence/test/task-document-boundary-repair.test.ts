import { fileURLToPath } from 'node:url'
import { buildSession } from '../src/format/validation.ts'
import { mkdtemp, rm, writeFile, readFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { lockPathFor } from '@i-harness/fs-lock'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createTaskDocumentObservation } from '../../session-persistence-jsonl/src/backend/task-document-observation.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createDocuments } from '../src/coordinator/documents.ts'
import { createMutations } from '../src/coordinator/mutations.ts'
import { createLoads } from '../src/coordinator/load.ts'
import { createManagedDocuments } from '../src/coordinator/managed-documents.ts'

const faults = vi.hoisted(() => {
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener
  const state = { signal: undefined as AbortSignal | undefined, listener: undefined as EventListenerOrEventListenerObject | undefined,
    failInstall: false, failRemove: false, leasePath: '', failLease: false, filePath: '', fileCloses: 0, add, remove }
  EventTarget.prototype.addEventListener = function (...args: Parameters<typeof add>) {
    Reflect.apply(add, this, args)
    if (this === state.signal && args[0] === 'abort') { state.listener = args[1] ?? undefined; if (state.failInstall) throw null }
  }
  EventTarget.prototype.removeEventListener = function (...args: Parameters<typeof remove>) {
    if (this === state.signal && args[0] === 'abort' && state.failRemove) throw false
    Reflect.apply(remove, this, args)
  }
  return state
})
vi.mock('@i-harness/fs-lock', async original => {
  const real = await original<typeof import('@i-harness/fs-lock')>()
  return { ...real, async acquireSessionLock(...args: Parameters<typeof real.acquireSessionLock>) {
    const lock = await real.acquireSessionLock(...args), release = lock.release
    return { get held() { return lock.held }, release() {
      if (args[0].lockPath === faults.leasePath && faults.failLease) throw false
      return Reflect.apply(release, lock, [])
    } }
  } }
})
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args), close = handle.close
    handle.close = async () => { await Reflect.apply(close, handle, []); if (String(args[0]) === faults.filePath) faults.fileCloses++ }
    return handle
  } }
})
afterAll(() => { EventTarget.prototype.addEventListener = faults.add; EventTarget.prototype.removeEventListener = faults.remove })

const literal = '{"formatVersion":2,"tasks":[],"notifications":[]}'
async function fixture(hook: (ownership: ReturnType<typeof createOwnership>) => void, at: 'validator' | 'observe' | 'confirm' = 'validator', historicalAbsent = false) {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-boundary-')), backend = createJsonlBackend(root), options = { lock: { enabled: true } }
  const ownership = createOwnership(backend, options)
  let managed: ReturnType<typeof createManagedDocuments>
  const documents = createDocuments(backend, ownership, () => {}, undefined, {
    captureParent: document => managed.captureParent(document),
    validator: { validate(value) { taskDocumentStorageContract.validate(value); if (at === 'validator') hook(ownership) } },
    open(scope) { const raw = createTaskDocumentObservation(root, join(root, `${scope.key}.doc.jsonl`), scope); return {
      async observe() { if (at === 'observe') hook(ownership); return raw.observe() },
      async confirm(witness) { if (at === 'confirm') hook(ownership); return raw.confirm(witness) }, settleResources: raw.settleResources.bind(raw),
    } },
  })
  const mutations = createMutations(backend, ownership, 200, () => {}, undefined, documents.observations), loads = createLoads(backend, ownership, mutations)
  managed = createManagedDocuments(backend, ownership, loads.loadOwned, options, () => {}, mutations, undefined,
    id => documents.observations.assertOutsideOwnedOperations([id]), id => documents.observations.revokeOwnedDocumentOperations(id))
  // Historical lower-owner control: retain genuine original13 bytes/id without writable14 admission.
  const original = fileURLToPath(new URL('../../session-persistence-jsonl/test/fixtures/original13-empty.jsonl', import.meta.url))
  const id = historicalAbsent ? 'p' : 'parent'
  if (historicalAbsent) await copyFile(original, join(root, 'p.jsonl'))
  else await mutations.create({ sessionId: id })
  if (historicalAbsent) managed = createManagedDocuments(backend, ownership, async sessionId => { await ownership.ensureOwnership(sessionId); const raw = await backend.read(sessionId); return { session: buildSession(raw.meta, raw.events) } }, options, () => {}, mutations, undefined,
    sessionId => documents.observations.assertOutsideOwnedOperations([sessionId]), sessionId => documents.observations.revokeOwnedDocumentOperations(sessionId))
  const parent = await managed.open(id)
  if (!historicalAbsent) await writeFile(join(root, 'task-parent.doc.jsonl'), literal)
  return { root, ownership, documents, parent, async assertHistoricalUnchanged() { expect(await readFile(join(root, 'p.jsonl'))).toEqual(await readFile(original)) }, operations: documents.taskOperations!, async close() {
    await documents.observations.closeAdmission()(); await managed.close(); await Promise.all(ownership.releaseHeldLocks()); await rm(root, { recursive: true, force: true })
  } }
}

it.each(['validator', 'observe', 'confirm'] as const)('refuses original parent queue admission from %s before callback effects', async at => {
  let calls = 0, foreignCalls = 0, attempts: Promise<unknown>[] = [], escaped: Promise<unknown> | undefined
  const leave = Promise.withResolvers<void>()
  const f = await fixture(owner => {
    const enter = () => owner.withSessionOperation('parent', async () => { calls++; return 'wrong' })
    attempts = [enter(), owner.withSessionOperation('other', () => { foreignCalls++; return enter() })]
    for (const attempt of attempts) void attempt.catch(() => {})
    escaped = leave.promise.then(enter); void escaped.catch(() => {})
  }, at)
  try {
    const operation = await f.operations.begin(f.operations.parent(f.parent)), observation = await operation.observe()
    if (observation.kind !== 'present') throw new Error('missing')
    expect((await operation.confirm(observation.witness)).kind).toBe('confirmed')
    for (const attempt of attempts) await expect(attempt).rejects.toThrow('TASK_DOCUMENT_CONFLICT')
    expect(calls).toBe(0); expect(foreignCalls).toBe(1); await operation.close()
    leave.resolve(); await expect(escaped).rejects.toThrow('TASK_DOCUMENT_CONFLICT'); expect(calls).toBe(0)
    expect(await f.ownership.withSessionOperation('parent', async () => 'external')).toBe('external')
    expect((await f.parent.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
  } finally { leave.resolve(); await escaped?.catch(() => {}); await f.close() }
})

it('owns a falsey listener install failure and retries only its original cleanup after possible registration', async () => {
  const f = await fixture(() => {}, 'validator', true)
  try {
    const operations = f.operations, token = operations.parent(f.parent)
    const controller = new AbortController(); faults.signal = controller.signal; faults.failInstall = true; faults.failRemove = true
    let failure: unknown; try { await operations.begin(token, { signal: controller.signal }) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error); expect((failure as Error).cause).toBeNull()
    expect((failure as Error & { cleanupCause: unknown }).cleanupCause).toBe(false)
    const cleanup = operations.cleanupFor(failure); expect(cleanup).toBeDefined()
    await expect(operations.begin(token)).rejects.toThrow()
    await expect(cleanup!.retry()).rejects.toBe(false)
    faults.failInstall = false; faults.failRemove = false; await cleanup!.retry()
    const operation = await operations.begin(token); expect(await operation.observe()).toEqual({ kind: 'absent' }); await operation.close(); await f.assertHistoricalUnchanged()
  } finally {
    faults.failInstall = false; faults.failRemove = false
    if (faults.signal && faults.listener) Reflect.apply(faults.remove, faults.signal, ['abort', faults.listener])
    faults.signal = undefined; faults.listener = undefined; await f.close()
  }
})

it('retains its genuine parent claim while original native document lease release fails until explicit retry', async () => {
  const f = await fixture(() => {}), pin = f.ownership.pinOwnership
  let originalPin: Awaited<ReturnType<typeof pin>> | undefined
  f.ownership.pinOwnership = async id => { const claim = await pin(id); originalPin = claim; return claim }
  faults.leasePath = lockPathFor(f.root, 'doc:task-parent'); faults.filePath = join(f.root, 'task-parent.doc.jsonl'); faults.fileCloses = 0
  try {
    const token = f.operations.parent(f.parent), operation = await f.operations.begin(token), observed = await operation.observe()
    expect(observed.kind).toBe('present'); expect(faults.fileCloses).toBe(1)
    faults.failLease = true; const close = operation.close(); await expect(close).rejects.toBe(false)
    expect(operation.close()).toBe(close); await expect(operation.close()).rejects.toBe(false)
    expect(() => originalPin!.assertHeld()).not.toThrow(); expect(faults.fileCloses).toBe(1)
    await expect(f.documents.joinTaskDocumentIO()).rejects.toThrow(); await expect(f.operations.begin(token)).rejects.toThrow()
    await expect(f.documents.putDocumentStrict('task-parent', { formatVersion: 2, tasks: [], notifications: [] })).rejects.toThrow()
    expect(() => originalPin!.assertHeld()).not.toThrow()
    faults.failLease = false; await operation.retryClose(); expect(() => originalPin!.assertHeld()).toThrow(); expect(faults.fileCloses).toBe(1)
    const next = await f.operations.begin(token); await next.close()
  } finally { faults.failLease = false; faults.leasePath = ''; faults.filePath = ''; await f.close() }
})
