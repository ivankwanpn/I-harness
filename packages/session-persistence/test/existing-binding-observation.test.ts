import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { acquireSessionLock, lockPathFor } from '@i-harness/fs-lock'
import { legacyPrefixDigest } from '@i-harness/core-session'
import { createSessionCoordinator as createBareSessionCoordinator, compileSemanticSeed, type SessionCoordinator, type SessionMeta, type ExistingSessionBindingObservation, type ExistingSessionBindingObservationRequest, type PersistenceBackend, type BootstrapRequest } from '../src/index.ts'

import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
const createSessionCoordinator = (backend: PersistenceBackend, options?: Parameters<typeof composeJsonlTaskTransitionCoordinator>[1]) => composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract)

import { artifactPathsFor } from '../src/coordinator/artifact-path-association.ts'
const backends = new Map<string, PersistenceBackend>()
function resourcePath(root: string, kind: 'session' | 'task' | 'document' | 'lease', id: string) {
  const paths = artifactPathsFor(backends.get(root)!)!
  const capture = kind === 'session' ? paths.session(id) : kind === 'task' ? paths.taskForParent(id) : paths.document(id)
  if (capture.kind !== 'ready') throw new Error('Fixture artifact parent must be ready')
  return lockPathFor(root, (kind === 'lease' ? 'artifact-document-lease:' : 'artifact-ownership:') + capture.key)
}
const sessionPaths = (root: string, id: string) => {
  const paths = artifactPathsFor(backends.get(root)!)!, captures = [paths.session(id), paths.taskForParent(id)]
  return captures.map(capture => { if (capture.kind !== 'ready') throw new Error('Fixture parent unavailable'); return 'artifact-ownership:' + capture.key }).sort().map(resource => lockPathFor(root, resource))
}
const documentPaths = (root: string, id: string) => [resourcePath(root, 'document', id), resourcePath(root, 'lease', id)]
// Observe the original read paths without replacing captured backend descriptors.
const io = vi.hoisted(() => ({ profile: vi.fn<(id: string) => void>(), readDocumentObserved: vi.fn<(key: string) => void>(), getDocument: vi.fn<(key: string) => void>() }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, async readFile(...args: Parameters<typeof actual.readFile>) {
    const path = String(args[0]).replaceAll('\\', '/'), file = path.slice(path.lastIndexOf('/') + 1), encoding = args[1]
    if (file.endsWith('.doc.jsonl')) {
      if (encoding === 'utf8') io.readDocumentObserved(file.slice(0, -10))
      if (encoding === 'utf-8') io.getDocument(file.slice(0, -10))
    } else if (file.endsWith('.jsonl') && encoding === 'utf-8') io.profile(file.slice(0, -6))
    return actual.readFile(...args)
  } }
})
function monitor(name: keyof typeof io) { io[name].mockClear(); return io[name] }
// Fault controls change behavior inside methods captured by the original backend.
const backendCalls = vi.hoisted(() => ({ readBootstrapState: vi.fn(), prepareBootstrapHeader: vi.fn(), reconcileBootstrapHeader: vi.fn(), appendOwnedBatch: vi.fn(), confirmBootstrapFrames: vi.fn() }))
const faults = vi.hoisted(() => ({ headerUnknown: false, headerGate: undefined as undefined | (() => Promise<void>), appendUnknown: false, reconcileUnknown: false }))
vi.mock('../../session-persistence-jsonl/src/backend/bootstrap-header.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session-persistence-jsonl/src/backend/bootstrap-header.ts')>()
  return { ...actual, createBootstrapHeaderBackend(...args: Parameters<typeof actual.createBootstrapHeaderBackend>) {
    const original = actual.createBootstrapHeaderBackend(...args)
    return { ...original,
      readBootstrapState(...input: Parameters<typeof original.readBootstrapState>) { backendCalls.readBootstrapState(...input); return original.readBootstrapState(...input) },
      reconcileBootstrapHeader(...input: Parameters<typeof original.reconcileBootstrapHeader>) { backendCalls.reconcileBootstrapHeader(...input); return original.reconcileBootstrapHeader(...input) }, async prepareBootstrapHeader(...input: Parameters<typeof original.prepareBootstrapHeader>) {
      backendCalls.prepareBootstrapHeader(...input)
      await faults.headerGate?.()
      const outcome = await original.prepareBootstrapHeader(...input)
      return faults.headerUnknown ? { kind: 'unknown' as const } : outcome
    } }
  } }
})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
  return { ...actual, createFactJournalBackend(...args: Parameters<typeof actual.createFactJournalBackend>) {
    const original = actual.createFactJournalBackend(...args)
    return { ...original, async confirmBootstrapFrames(...input: Parameters<typeof original.confirmBootstrapFrames>) {
      backendCalls.confirmBootstrapFrames(...input); return original.confirmBootstrapFrames(...input)
    }, async appendOwnedBatch(...input: Parameters<typeof original.appendOwnedBatch>) {
      backendCalls.appendOwnedBatch(...input)
      const outcome = await original.appendOwnedBatch(...input)
      return faults.appendUnknown && input[0] === 'source' ? { kind: 'unknown' as const, key: input[3].key } : outcome
    }, async reconcileOwnedBatch(...input: Parameters<typeof original.reconcileOwnedBatch>) {
      return faults.reconcileUnknown && input[0] === 'source' ? { kind: 'unknown' as const, key: input[3].key } : original.reconcileOwnedBatch(...input)
    } }
  } }
})
vi.mock('@i-harness/fs-lock', async importOriginal => {
  const actual = await importOriginal<typeof import('@i-harness/fs-lock')>()
  return { ...actual, acquireSessionLock: vi.fn(actual.acquireSessionLock) }
})
const nativeAcquire = (await vi.importActual<typeof import('@i-harness/fs-lock')>('@i-harness/fs-lock')).acquireSessionLock
const roots: string[] = [], coordinators: SessionCoordinator[] = []
const fast = { acquireRetryMs: 1, acquireDeadlineMs: 25 }
const createdAt = '2026-10-25T00:00:00.000Z'
const key = (id: string) => `desktop-session-project-${createHash('sha256').update(id).digest('hex')}`
const request = { sessionIds: ['source'] }
const invocation = { version: 1 as const, operationId: 'existing-read-separation', targetSessionId: 'source', createdAt, requestDigest: 'a'.repeat(64) }
const never = async (): Promise<never> => { throw new Error('empty dependency closure must not use transfer port') }
const guards = { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } }
afterEach(async () => {
  for (const probe of [...Object.values(io), ...Object.values(backendCalls)]) probe.mockReset(); faults.headerUnknown = false; faults.headerGate = undefined; faults.appendUnknown = false; faults.reconcileUnknown = false; vi.restoreAllMocks(); vi.mocked(acquireSessionLock).mockImplementation(nativeAcquire)
  for (const c of coordinators.splice(0)) await c.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(persistent = false) {
  const root = await mkdtemp(join(tmpdir(), 'existing-binding-')); roots.push(root)
  const backend = createJsonlBackend(root) as PersistenceBackend & Required<Pick<PersistenceBackend, 'readDocumentObserved'>>; backends.set(root, backend)
  const c = createSessionCoordinator(backend, { ...fast, maxDelayMs: 60_000, lock: { enabled: true, lockRoot: root } }); coordinators.push(c)
  if (persistent) await c.create({ sessionId: 'source', createdAt, title: 'original' })
  else { await c.create({ sessionId: 'source', createdAt, title: 'original' }); await c.releaseOwnership('source') }
  return { root, backend, c }
}
async function existingEmpty(f: Awaited<ReturnType<typeof fixture>>): Promise<BootstrapRequest> {
  const raw = await readFile(join(f.root, 'source.jsonl'))
  return { invocation, target: { kind: 'existing-empty', expectedHeaderDigest: createHash('sha256').update(raw).digest('hex'), expectedPrefix: { eventCount: 0, bodyBytes: 0, prefixDigest: legacyPrefixDigest(0, new Uint8Array()) } }, metadata: { title: 'bootstrapped' }, lineage: { origin: 'fork', parentSession: 'parent' }, seed: compileSemanticSeed({ kind: 'none' }) }
}
function hold(c: SessionCoordinator, ids = ['source']) {
  const entered = Promise.withResolvers<ExistingSessionBindingObservation>(), leave = Promise.withResolvers<void>()
  const running = c.withExistingSessionBindingObservation!({ sessionIds: ids }, async observed => { entered.resolve(observed); await leave.promise; return 'old-result' })
  const outcome = running.then(value => value, error => error)
  return { entered: entered.promise, leave: leave.resolve, outcome }
}

it('E00 exposes the real optional owner only under the original supported capability gate', async () => {
  const { backend, c } = await fixture()
  expect(typeof c.withExistingSessionBindingObservation).toBe('function')
  expect(await c.withExistingSessionBindingObservation!(request, async read => read.metadata('source').title)).toBe('original')
  for (const candidate of [createBareSessionCoordinator(backend), createBareSessionCoordinator({ ...backend, readDocumentObserved: undefined } as PersistenceBackend, { lock: { enabled: true } })]) {
    coordinators.push(candidate)
    expect(candidate.withExistingSessionBindingObservation).toBeUndefined()
    expect(candidate.withSessionBindingObservation).toBeUndefined()
  }
})

it('E01 closes plain dense request descriptors without invoking accessors, proxies or iterators', async () => {
  const { c } = await fixture()
  let calls = 0
  const trap = () => { calls++; throw new Error('caller code executed') }
  const accessor = Object.defineProperty({}, 'sessionIds', { enumerable: true, get: trap })
  const index = Object.defineProperty(['source'], 0, { enumerable: true, get: trap })
  class Expanded extends Array<string> { override *[Symbol.iterator](): ArrayIterator<string> { calls++; yield 'source' } }
  const proxy = new Proxy(request, { ownKeys: trap, getPrototypeOf: trap })
  const idsProxy = new Proxy(['source'], { ownKeys: trap, getPrototypeOf: trap })
  const iterator = Object.defineProperty(['source'], Symbol.iterator, { value: trap })
  const extra = Object.assign(['source'], { extra: true })
  const nonenumerable = Object.defineProperty({ sessionIds: ['source'] }, 'signal', { value: undefined })
  const invalid = [accessor, proxy, { sessionIds: idsProxy }, { sessionIds: index }, { sessionIds: new Expanded('source') }, { sessionIds: iterator }, { sessionIds: extra }, nonenumerable,
    {}, { sessionIds: [] }, { sessionIds: Array.from({ length: 65 }, (_, i) => `s${i}`) }, { sessionIds: ['source', 'source'] }, { sessionIds: ['../source'] }, { sessionIds: [''] }, { sessionIds: ['a/b'] }, { sessionIds: new Array(1) },
    { ...request, signal: undefined }, { ...request, signal: {} }, { ...request, target: invocation }, { ...request, invocation }, { existingSessionIds: ['source'] }, { ...request, extra: undefined }, { ...request, [Symbol('extra')]: 1 }]
  const profile = monitor('profile'), read = monitor('readDocumentObserved')
  vi.mocked(acquireSessionLock).mockClear()
  for (const value of invalid) await expect(c.withExistingSessionBindingObservation!(value as ExistingSessionBindingObservationRequest, async () => 0)).rejects.toMatchObject({ reason: 'invalid' })
  await expect(c.withExistingSessionBindingObservation!(request, null as never)).rejects.toMatchObject({ reason: 'invalid' })
  expect(calls).toBe(0); expect(acquireSessionLock).not.toHaveBeenCalled(); expect(profile).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
})

it('E01 accepts exactly 64 real existing IDs and acquires no target lease or extra key', async () => {
  const { root, c } = await fixture()
  const ids = ['source', ...Array.from({ length: 63 }, (_, i) => `session-${i}`)]
  await Promise.all(ids.slice(1).map(async id => { await c.create({ sessionId: id, createdAt }); await c.releaseOwnership(id) }))
  const paths: string[] = []
  vi.mocked(acquireSessionLock).mockImplementation(async options => { paths.push(options.lockPath); return nativeAcquire(options) })
  const read = monitor('readDocumentObserved')
  await c.withExistingSessionBindingObservation!({ sessionIds: ids }, async observed => { for (const id of ids) expect(observed.metadata(id).sessionId).toBe(id) })
  expect(paths).toEqual([...ids.toSorted().flatMap(id => sessionPaths(root, id)), ...ids.map(key).sort().flatMap(binding => documentPaths(root, binding))])
  expect(read.mock.calls.map(([binding]) => binding).sort()).toEqual(ids.map(key).sort())
  console.info(JSON.stringify({ control: 'E01 exact64 native', acquired: paths.length, sessions: 64, documents: read.mock.calls.length }))
})

it('E02 captures actual current immutable metadata and strict binding from the preawait ID set', async () => {
  const { backend, c } = await fixture(true)
  const stale = await c.openManagedDocument('source')
  await c.updateMeta('source', { title: 'current', workspaceId: 'workspace', parentSession: 'parent', seedLength: 0, origin: 'fork', modelSelection: { provider: 'route', model: 'model' } })
  await backend.putDocument(key('source'), { projectId: 'p', nested: { roots: ['actual'] } })
  const profile = monitor('profile'), read = monitor('readDocumentObserved'), ordinary = monitor('getDocument')
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  vi.mocked(acquireSessionLock).mockImplementation(async options => { const raw = await nativeAcquire(options); entered.resolve(); await leave.promise; return raw })
  const ids = ['source']; let retired!: ExistingSessionBindingObservation
  const running = c.withExistingSessionBindingObservation!({ sessionIds: ids }, async observed => {
    retired = observed
    expect(observed.metadata('source')).toMatchObject({ title: 'current', workspaceId: 'workspace', parentSession: 'parent', modelSelection: { provider: 'route', model: 'model' } })
    expect(observed.binding('source')).toEqual({ kind: 'present', value: { projectId: 'p', nested: { roots: ['actual'] } } })
    expect(Object.isFrozen(observed.metadata('source').modelSelection)).toBe(true)
    const binding = observed.binding('source'); if (binding.kind !== 'present') throw new Error('missing binding')
    expect(Object.isFrozen((binding.value as { nested: { roots: string[] } }).nested.roots)).toBe(true)
    expect(() => { (observed.metadata('source').modelSelection!).model = 'mutated' }).toThrow()
    for (const getter of [observed.metadata, observed.binding]) expect(() => getter('unknown')).toThrow(expect.objectContaining({ reason: 'invalid' }))
    expect((stale.view.header as Readonly<SessionMeta>)?.title).not.toBe('current')
    return 'captured'
  })
  try { await entered.promise; ids[0] = 'other' } finally { leave.resolve() }
  expect(await running).toBe('captured'); expect(profile.mock.calls).toEqual([['source']]); expect(read.mock.calls).toEqual([[key('source')]]); expect(ordinary).not.toHaveBeenCalled()
  for (const getter of [() => retired.assertCurrent(), () => retired.metadata('source'), () => retired.binding('source')]) expect(getter).toThrow(expect.objectContaining({ reason: 'revoked' }))
})

it.each(['archived', 'stale-managed-archive', 'missing', 'malformed-header', 'profile-error', 'wrong-identity'] as const)('E03 refuses actual %s without entering callback', async kind => {
  const { root, c } = await fixture()
  if (kind === 'stale-managed-archive') await c.openManagedDocument('source')
  if (kind === 'archived' || kind === 'stale-managed-archive') await c.updateMeta('source', { archived: true })
  if (kind === 'missing') await rm(join(root, 'source.jsonl'))
  if (kind === 'malformed-header') await writeFile(join(root, 'source.jsonl'), '{broken\n')
  if (kind === 'wrong-identity') {
    const lines = (await readFile(join(root, 'source.jsonl'), 'utf8')).split('\n')
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), sessionId: 'other' })
    await writeFile(join(root, 'source.jsonl'), lines.join('\n'))
  }
  const raw = new Error('profile I/O failed')
  if (kind === 'profile-error') monitor('profile').mockImplementationOnce(() => { throw raw })
  let calls = 0
  const failure = await c.withExistingSessionBindingObservation!(request, async () => { calls++ }).catch(error => error)
  expect(failure).toMatchObject({ reason: 'unavailable' }); expect(calls).toBe(0)
  if (kind === 'profile-error') expect(failure.cause).toBe(raw)
})

it.each([{ title: 'other' }, { archived: true }])('E04 mutation %j revokes synchronously, joins full lifetime and never revives after ABA', async patch => {
  const { backend, c } = await fixture(), held = hold(c)
  const old = await held.entered
  const changing = c.updateMeta('source', patch)
  try {
    expect(() => old.assertCurrent()).toThrow(); expect((await backend.profile('source')).meta).toMatchObject({ title: 'original' }); expect((await backend.profile('source')).meta.archived).not.toBe(true)
    await expect(c.withExistingSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'conflict' })
  } finally { held.leave(); await held.outcome; await changing }
  expect(await held.outcome).toMatchObject({ reason: 'revoked' })
  await c.updateMeta('source', { title: 'original', archived: false })
  expect(() => old.assertCurrent()).toThrow()
  await c.withExistingSessionBindingObservation!(request, async fresh => expect(fresh.metadata('source').title).toBe('original'))
})

it.each(['strict', 'ordinary'] as const)('E05 matching %s binding write revokes and joins while unrelated keys progress', async mode => {
  const { backend, c } = await fixture(); await backend.putDocument(key('source'), { projectId: 'original' })
  const held = hold(c), old = await held.entered
  const changing = mode === 'strict' ? c.putDocumentStrict!(key('source'), { projectId: 'other' }) : c.putDocument(key('source'), { projectId: 'other' })
  try {
    expect(() => old.assertCurrent()).toThrow()
    expect(await backend.readDocumentObserved!(key('source'))).toEqual({ kind: 'present', value: { projectId: 'original' } })
    await c.putDocumentStrict!('unrelated-key', { changed: true })
    await expect(c.withExistingSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'conflict' })
  } finally { held.leave(); await held.outcome; await changing }
  await c.putDocumentStrict!(key('source'), { projectId: 'original' })
  expect(() => old.assertCurrent()).toThrow()
  await c.withExistingSessionBindingObservation!(request, async fresh => expect(fresh.binding('source')).toEqual({ kind: 'present', value: { projectId: 'original' } }))
})

it('E05 malformed strict binding remains unavailable and retains raw parse failure', async () => {
  const { root, c } = await fixture(); await writeFile(join(root, `${key('source')}.doc.jsonl`), '{broken')
  let calls = 0
  const failure = await c.withExistingSessionBindingObservation!(request, async () => { calls++ }).catch(error => error)
  expect(failure).toMatchObject({ reason: 'unavailable', cause: expect.any(SyntaxError) }); expect(calls).toBe(0)
})

it('E06 owned deletion waits callback cleanup before actual tombstone, file removal and listener', async () => {
  const { root, backend, c } = await fixture(); await backend.putDocument(key('source'), { projectId: 'p' })
  const held = hold(c), old = await held.entered
  const marker = join(root, `desktop-deleted-session-${createHash('sha256').update('source').digest('hex')}.tombstone`)
  let listeners = 0
  c.onDocumentDeleted!(async id => { listeners++; expect(id).toBe('source'); await expect(stat(join(root, 'source.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' }); expect((await stat(marker)).isFile()).toBe(true) })
  const deleting = c.deleteOwnedSession!('source', { documents: [key('source')] })
  try { expect(() => old.assertCurrent()).toThrow(); expect(listeners).toBe(0); expect((await stat(join(root, 'source.jsonl'))).isFile()).toBe(true); await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' }) }
  finally { held.leave(); await held.outcome; await deleting }
  expect(await held.outcome).toMatchObject({ reason: 'revoked' }); expect(listeners).toBe(1)
  await expect(c.withExistingSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'deleted' })
  const fresh = createSessionCoordinator(backend, { ...fast, lock: { enabled: true, lockRoot: root } }); coordinators.push(fresh)
  await expect(fresh.withExistingSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'deleted' })
})

it.each(['releaseOwnership', 'closeManagedDocument'] as const)('E07 %s retires immediately, fences later adopter and permits fresh ordinary reopen', async method => {
  const { c } = await fixture(true); await c.openManagedDocument('source')
  const held = hold(c), old = await held.entered
  let settled = false
  const retiring = c[method]('source').then(() => { settled = true })
  try { expect(() => old.assertCurrent()).toThrow(); await expect(c.adoptOwnership('source')).rejects.toMatchObject({ reason: 'conflict' }); expect(settled).toBe(false) }
  finally { held.leave(); await held.outcome; await retiring }
  await c.openManagedDocument('source')
  await c.withExistingSessionBindingObservation!(request, async fresh => { fresh.assertCurrent(); expect(() => old.assertCurrent()).toThrow() })
})

it.each([['abort', 1], ['abort', 2], ['abort', 3], ['abort', 4], ['abort', 5], ['abort', 6], ['abort', 7], ['abort', 8], ['close', 1], ['close', 2], ['close', 3], ['close', 4], ['close', 5], ['close', 6], ['close', 7], ['close', 8]] as const)('E08 %s at cold native acquisition %s joins late handle and releases every obtained lease', async (mode, cut) => {
  const { root, c } = await fixture(); await c.create({ sessionId: 'ancestor', createdAt }); await c.releaseOwnership('ancestor')
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>(), controller = new AbortController()
  let acquired = 0, released = 0, live = 0, callbacks = 0
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options); acquired++; live++
    if (acquired === cut) { entered.resolve(); await leave.promise }
    return { get held() { return raw.held }, async release() { await raw.release(); released++; live-- } }
  })
  const running = c.withExistingSessionBindingObservation!({ sessionIds: ['source', 'ancestor'], signal: controller.signal }, async () => { callbacks++ })
  const rejected = expect(running).rejects.toMatchObject({ reason: 'revoked' })
  await entered.promise
  let closed = false; const closing = mode === 'close' ? c.close().then(() => { closed = true }) : undefined
  if (mode === 'abort') controller.abort()
  try { await Promise.resolve(); expect(closed).toBe(false); expect(live).toBe(cut) }
  finally { leave.resolve(); await rejected; await closing }
  expect([callbacks, acquired, released, live, c.ownerOf('source'), c.ownerOf('ancestor')]).toEqual([0, 2 * Math.ceil(cut / 2), 2 * Math.ceil(cut / 2), 0, false, false])
  if (mode === 'close') await expect(c.withExistingSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'revoked' })
  const probe = await nativeAcquire({ lockPath: sessionPaths(root, 'source')[0]!, deadlineMs: 20 }); await probe.release()
  console.info(JSON.stringify({ control: 'E08 real native acquisition cut', mode, cut, acquired, released, live, callbacks }))
})

it('E08 close during original disposal is single flight and callback result waits cleanup', async () => {
  const { root, c } = await fixture(), entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  const acquiredPaths: string[] = [], releasedPaths: string[] = []
  let releases = 0, completed = false
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options); acquiredPaths.push(options.lockPath)
    return { get held() { return raw.held }, async release() { releasedPaths.push(options.lockPath); releases++; if (releases === 1) { entered.resolve(); await leave.promise }; await raw.release() } }
  })
  const running = c.withExistingSessionBindingObservation!(request, async () => 'original').then(value => { completed = true; return value })
  await entered.promise; const closing = c.close()
  try { await Promise.resolve(); expect(releases).toBe(1); expect(completed).toBe(false) } finally { leave.resolve() }
  expect(await running).toBe('original'); await closing; expect(acquiredPaths).toEqual([...sessionPaths(root, 'source'), ...documentPaths(root, key('source'))]); expect(releasedPaths).toEqual([...documentPaths(root, key('source')).reverse(), ...sessionPaths(root, 'source').reverse()]); expect(releases).toBe(acquiredPaths.length)
})

it('E08 active close revokes immediately and joins original callback', async () => {
  const { c } = await fixture(), held = hold(c), old = await held.entered
  const closing = c.close()
  try { expect(() => old.assertCurrent()).toThrow(); expect(c.ownerOf('source')).toBe(true) } finally { held.leave(); await held.outcome; await closing }
  expect(await held.outcome).toMatchObject({ reason: 'revoked' }); expect(c.ownerOf('source')).toBe(false)
})

it.each([['addEventListener', 'accessor'], ['addEventListener', 'method'], ['removeEventListener', 'accessor'], ['removeEventListener', 'method'], ['aborted', 'accessor']] as const)('E08 branded signal ignores shadowed %s %s', async (property, kind) => {
  const { c } = await fixture(), controller = new AbortController(); let calls = 0
  const override = () => { calls++; throw new Error('caller override') }
  Object.defineProperty(controller.signal, property, kind === 'accessor' ? { get: override } : { value: override })
  await expect(c.withExistingSessionBindingObservation!({ ...request, signal: controller.signal }, async read => { read.assertCurrent(); controller.abort(); expect(() => read.assertCurrent()).toThrow() })).rejects.toMatchObject({ reason: 'revoked' })
  expect(calls).toBe(0); expect(c.ownerOf('source')).toBe(false)
})
it('E08 preaborted branded signal refuses before native acquisition despite shadowed false state', async () => {
  const { c } = await fixture(), controller = new AbortController(); controller.abort(); let calls = 0
  Object.defineProperty(controller.signal, 'aborted', { get() { calls++; return false } }); vi.mocked(acquireSessionLock).mockClear()
  await expect(c.withExistingSessionBindingObservation!({ ...request, signal: controller.signal }, async () => 0)).rejects.toMatchObject({ reason: 'revoked' })
  expect(calls).toBe(0); expect(acquireSessionLock).not.toHaveBeenCalled()
})

it('E09 self waits refuse before pending work and preserve current nested scope stack', async () => {
  const { backend, c } = await fixture()
  await c.create({ sessionId: 'unrelated', createdAt }); await c.releaseOwnership('unrelated')
  await c.withExistingSessionBindingObservation!(request, async outer => {
    for (const operation of [() => c.updateMeta('source', { title: 'no' }), () => c.putDocumentStrict!(key('source'), {}), () => c.putDocument(key('source'), {}), () => c.profile('source'), () => c.load('source'), () => c.loadOwned('source'), () => c.openManagedDocument('source'), () => c.ensureWritableFormat!('source'), () => c.deleteOwnedSession!('source', { documents: [key('source')] }), () => c.releaseOwnership('source'), () => c.closeManagedDocument('source'), () => c.close(), () => c.withExistingSessionBindingObservation!(request, async () => 0), () => c.withSessionBindingObservation!({ existingSessionIds: ['source'], target: { ...invocation, targetSessionId: 'target' } }, async () => 0)]) {
      await expect(Promise.resolve().then(async () => operation())).rejects.toMatchObject({ reason: 'conflict' }); outer.assertCurrent()
    }
    await c.withExistingSessionBindingObservation!({ sessionIds: ['unrelated'] }, async inner => {
      await expect(c.updateMeta('source', { title: 'outer-self-wait' })).rejects.toMatchObject({ reason: 'conflict' })
      outer.assertCurrent(); inner.assertCurrent(); await c.putDocumentStrict!('independent', 1)
    })
    await c.updateMeta('unrelated', { title: 'progress' }); outer.assertCurrent()
  })
  expect((await backend.profile('source')).meta.title).toBe('original')
})

it('E10 cold read native leases exclude a foreign metadata writer, binding writer and observation until release', async () => {
  const { root, backend, c } = await fixture()
  const other = createSessionCoordinator(backend, { ...fast, lock: { enabled: true, lockRoot: root } }); coordinators.push(other)
  await c.withExistingSessionBindingObservation!(request, async read => {
    await expect(other.updateMeta('source', { title: 'foreign' })).rejects.toMatchObject({ message: 'TASK_TRANSITION_FAILED', cause: { name: 'SessionLockConflictError' } })
    await expect(other.putDocumentStrict!(key('source'), { projectId: 'foreign' })).rejects.toMatchObject({ name: 'SessionLockConflictError' })
    await expect(other.withExistingSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'conflict' })
    read.assertCurrent(); expect((await backend.profile('source')).meta.title).toBe('original'); expect(await backend.readDocumentObserved!(key('source'))).toEqual({ kind: 'absent' })
  })
  expect(c.ownerOf('source')).toBe(false)
  await other.updateMeta('source', { title: 'foreign' }); await other.putDocumentStrict!(key('source'), { projectId: 'foreign' })
  await other.withExistingSessionBindingObservation!(request, async read => expect(read.metadata('source').title).toBe('foreign'))
})

it.each(['bootstrap', 'resume'] as const)('E11 read self %s has no target exception or backend birth work', async mode => {
  const f = await fixture(), original = await existingEmpty(f), before = await readFile(join(f.root, 'source.jsonl'))
  const prepare = backendCalls.prepareBootstrapHeader; prepare.mockClear()
  await f.c.withExistingSessionBindingObservation!(request, async read => {
    const operation = mode === 'bootstrap' ? f.c.bootstrapSemanticTarget(original, guards) : f.c.resumeSemanticTarget(original.invocation, guards, original)
    await expect(operation).rejects.toMatchObject({ reason: 'conflict' }); read.assertCurrent(); expect(prepare).not.toHaveBeenCalled()
  })
  expect(await readFile(join(f.root, 'source.jsonl'))).toEqual(before)
})

it.each(['bootstrap', 'resume'] as const)('E11 external %s revokes read synchronously, joins then performs actual B2', async mode => {
  const f = await fixture(), original = await existingEmpty(f), held = hold(f.c), read = await held.entered
  const operation = mode === 'bootstrap' ? f.c.bootstrapSemanticTarget(original, guards) : f.c.resumeSemanticTarget(original.invocation, guards, original)
  try { expect(() => read.assertCurrent()).toThrow(); expect((await f.backend.profile('source')).meta.title).toBe('original'); await expect(f.c.withExistingSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'conflict' }) }
  finally { held.leave(); await held.outcome }
  expect(await held.outcome).toMatchObject({ reason: 'revoked' }); expect(await operation).toMatchObject({ kind: 'ready', receipt: { invocation } })
  expect((await f.backend.profile('source')).meta).toMatchObject({ title: 'bootstrapped', parentSession: 'parent' })
})

it('E11 bootstrap-first pending header admission rejects read immediately', async () => {
  const f = await fixture(), original = await existingEmpty(f), entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  faults.headerGate = async () => { entered.resolve(); await leave.promise }
  const bootstrapping = f.c.bootstrapSemanticTarget(original, guards)
  try { await entered.promise; await expect(f.c.withExistingSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'conflict' }) }
  finally { leave.resolve() }
  expect(await bootstrapping).toMatchObject({ kind: 'ready' })
})

it('E12 mixed nested fork/read scopes retain only the exact fork target bootstrap exemption', async () => {
  const { c } = await fixture(); await c.create({ sessionId: 'unrelated', createdAt }); await c.releaseOwnership('unrelated')
  const target = { ...invocation, targetSessionId: 'target' }, profile = monitor('profile')
  await c.withSessionBindingObservation!({ existingSessionIds: ['source'], target }, async fork => {
    await c.withExistingSessionBindingObservation!({ sessionIds: ['unrelated'] }, async read => {
      expect(await c.bootstrapSemanticTarget({ invocation: target, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork' }, seed: compileSemanticSeed({ kind: 'none' }) }, guards)).toMatchObject({ kind: 'ready' })
      read.assertCurrent(); fork.assertCurrent()
      await expect(c.updateMeta('source', { title: 'self' })).rejects.toMatchObject({ reason: 'conflict' })
    })
  })
  expect(profile.mock.calls.map(([id]) => id)).not.toContain('target')
})

it('E13 partial later document acquisition releases earlier temporaries but preserves persistent adopter and sorted order', async () => {
  const { root, c } = await fixture(true); await c.create({ sessionId: 'ancestor', createdAt }); await c.releaseOwnership('ancestor')
  const bindings = ['source', 'ancestor'].map(key).sort(), held = await nativeAcquire({ lockPath: resourcePath(root, 'lease', bindings[1]!) })
  const paths: string[] = []
  vi.mocked(acquireSessionLock).mockImplementation(async options => { paths.push(options.lockPath); return nativeAcquire(options) })
  try { await expect(c.withExistingSessionBindingObservation!({ sessionIds: ['source', 'ancestor'] }, async () => 0)).rejects.toMatchObject({ reason: 'conflict' }) }
  finally { await held.release() }
  expect(paths).toEqual([...sessionPaths(root, 'ancestor'), ...bindings.flatMap(binding => documentPaths(root, binding))])
  expect(c.ownerOf('source')).toBe(true); expect(c.ownerOf('ancestor')).toBe(false)
  for (const path of [...sessionPaths(root, 'ancestor'), ...documentPaths(root, bindings[0]!)]) { const probe = await nativeAcquire({ lockPath: path, deadlineMs: 20 }); await probe.release() }
  await c.putDocumentStrict!('unrelated', 1)
})

it('E13 failed concurrent temporary scope cannot release the first scope native claim', async () => {
  const { root, c } = await fixture()
  const a = hold(c), first = await a.entered
  // Binding leases are exclusive even in the same coordinator; position B at
  // session pin acquisition then fail its document lease without touching A.
  try {
    await expect(c.withExistingSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'conflict' })
    first.assertCurrent(); expect(c.ownerOf('source')).toBe(true)
    await expect(nativeAcquire({ lockPath: sessionPaths(root, 'source')[0]!, deadlineMs: 10 })).rejects.toThrow()
  } finally { a.leave(); await a.outcome }
  expect(await a.outcome).toBe('old-result'); expect(c.ownerOf('source')).toBe(false)
})

it('E14 failed native release before action retains result/IDs and retries the same handle while preserving live owner', async () => {
  const { root, c } = await fixture(true)
  let acquired = 0, attempts = 0, rawHeld = false
  const rawFailure = new Error('before native release')
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options); acquired++
    return { get held() { return raw.held }, async release() { attempts++; if (attempts === 1) { rawHeld = raw.held; throw rawFailure }; await raw.release(); rawHeld = raw.held } }
  })
  const failure = await c.withExistingSessionBindingObservation!(request, async () => 'original-result').catch(error => error)
  expect(failure).toMatchObject({ callbackResult: 'original-result', sessionIds: ['source'] }); expect('invocation' in failure).toBe(false); expect(Object.isFrozen(failure.sessionIds)).toBe(true)
  expect(failure.errors[0].errors).toContain(rawFailure)
  expect([acquired, attempts, rawHeld, c.ownerOf('source')]).toEqual([documentPaths(root, key('source')).length, 1, true, true])
  await expect(nativeAcquire({ lockPath: resourcePath(root, 'lease', key('source')), deadlineMs: 10 })).rejects.toThrow()
  await c.close(); expect([acquired, attempts, rawHeld, c.ownerOf('source')]).toEqual([documentPaths(root, key('source')).length, documentPaths(root, key('source')).length + 1, false, false])
  console.info(JSON.stringify({ control: 'E14 native same handle retry', acquired, attempts, rawHeld }))
})

it('E15 consumed native unknown stays unresolved debt, never no-op success or owner replacement', async () => {
  const raws: Awaited<ReturnType<typeof nativeAcquire>>[] = [], byPath = new Map<string, Awaited<ReturnType<typeof nativeAcquire>>>(); let acquired = 0, attempts = 0, fault = false
  const rawFailure = new Error('consumed native release unknown')
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options); raws.push(raw); byPath.set(options.lockPath, raw); acquired++
    return { get held() { return raw.held }, async release() { attempts++; await raw.release(); if (fault && options.lockPath === resourcePath(roots.at(-1)!, 'lease', key('source'))) throw rawFailure } }
  })
  const { c } = await fixture(true); fault = true
  try {
    const failure = await c.withExistingSessionBindingObservation!(request, async () => 'original-result').catch(error => error)
    expect(failure).toMatchObject({ callbackResult: 'original-result', sessionIds: ['source'] }); expect(failure.errors[0].errors).toContain(rawFailure)
    expect(byPath.get(resourcePath(roots.at(-1)!, 'lease', key('source')))!.held).toBe(false); expect(c.ownerOf('source')).toBe(true)
    const before = { acquired, attempts }
    await expect(c.close()).rejects.toThrow('unresolved'); await expect(c.close()).rejects.toThrow('unresolved')
    expect({ acquired, attempts }).toEqual(before); expect(c.ownerOf('source')).toBe(true)
    console.info(JSON.stringify({ control: 'E15 consumed native debt', acquired, attempts, consumedHeld: byPath.get(resourcePath(roots.at(-1)!, 'lease', key('source')))!.held, dependentHeld: raws[0].held }))
  } finally { coordinators.splice(coordinators.indexOf(c), 1); for (const raw of raws) await raw.release() }
})

it('E16 callback result/error identity and final revocation guard survive cleanup semantics', async () => {
  const { c } = await fixture(), result = { original: true }, error = new Error('original callback')
  expect(await c.withExistingSessionBindingObservation!(request, async () => result)).toBe(result)
  await expect(c.withExistingSessionBindingObservation!(request, async () => { throw error })).rejects.toBe(error)
  const controller = new AbortController()
  await expect(c.withExistingSessionBindingObservation!({ ...request, signal: controller.signal }, async () => { controller.abort(); return result })).rejects.toMatchObject({ reason: 'revoked' })
})

it('E16 callback original error remains original when it throws after active revocation', async () => {
  const { c } = await fixture(), error = new Error('original callback after abort'), controller = new AbortController()
  await expect(c.withExistingSessionBindingObservation!({ ...request, signal: controller.signal }, async read => {
    read.assertCurrent(); controller.abort(); throw error
  })).rejects.toBe(error)
  expect(c.ownerOf('source')).toBe(false)
})

it('E16 cleanup failure aggregates the literal callback error and all independent disposers are attempted', async () => {
  const { root, c } = await fixture(), callbackError = new Error('original callback failure'), cleanupError = new Error('release before action')
  let attempts = 0
  const acquired = new Map<string, Awaited<ReturnType<typeof nativeAcquire>>>(), attempted: string[] = []
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options); acquired.set(options.lockPath, raw)
    return { get held() { return raw.held }, async release() { attempts++; attempted.push(options.lockPath); if (options.lockPath === resourcePath(root, 'lease', key('source')) && attempts === 1) throw cleanupError; await raw.release() } }
  })
  const failure = await c.withExistingSessionBindingObservation!(request, async () => { throw callbackError }).catch(error => error)
  expect(failure.callbackError).toBe(callbackError); expect(failure.errors[0]).toBe(callbackError); expect(failure.errors[1].errors).toContain(cleanupError); expect(failure.sessionIds).toEqual(['source']); expect(attempted.toSorted()).toEqual([resourcePath(root, 'lease', key('source'))])
  await c.close(); expect(attempts).toBe(acquired.size + 1); expect([...acquired.values()].every(raw => !raw.held)).toBe(true)
})

it('E17 metadata/binding observation permits actual managed fact append without pretending to freeze its view', async () => {
  const { c } = await fixture(), source = await c.openManagedDocument('source')
  await c.withExistingSessionBindingObservation!(request, async read => {
    const before = source.view.events.length
    expect((await source.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
    expect(source.view.events.length).toBeGreaterThan(before); read.assertCurrent()
  })
})
