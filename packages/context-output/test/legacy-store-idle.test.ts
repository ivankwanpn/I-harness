import { afterEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ bodyReads: 0, bodyOpens: 0, indexOpens: 0, close: undefined as undefined | ((path: string, close: () => Promise<void>) => Promise<void>), transfer: undefined as undefined | ReturnType<typeof import('../src/legacy/fork-transfer.ts').createLegacyForkOwner>['selected'], passive: undefined as undefined | ((store: import('../src/store.ts').ContextStore, work: (signal: AbortSignal, store: import('../src/store.ts').ContextStore) => Promise<unknown>) => Promise<unknown>) }))
vi.mock('../src/legacy/fork-transfer.ts', async original => {
  const module = await original<typeof import('../src/legacy/fork-transfer.ts')>()
  return { ...module, createLegacyForkOwner: (...args: Parameters<typeof module.createLegacyForkOwner>) => { io.passive = args[0].runPassive; const owner = module.createLegacyForkOwner(...args); io.transfer = owner.selected; return owner } }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => { if (String(args[0]).includes('blobs')) io.bodyReads++; return fs.readFile(...args) },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).includes('blobs')) io.bodyOpens++
      if (String(args[0]).endsWith('index.sqlite')) io.indexOpens++
      const handle = await fs.open(...args), close = handle.close.bind(handle)
      handle.close = () => io.close ? io.close(String(args[0]), close) : close()
      return handle
    },
  }
})
import { mkdtemp, readFile, rm, writeFile, utimes, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as locking from '@i-harness/fs-lock'
import { createContextOutputService, acquireColdSelectedQualification } from '../src/service.ts'
import { inspectColdSelectedTarget, useColdSelectedTarget, captureOriginalColdObservation } from '../../session-persistence/src/selected-source-owner.ts'
import { ContextStore } from '../src/store.ts'
import { LegacyIndexLifecycle } from '../src/legacy/index-lifecycle.ts'
import { createLegacyUseGate } from '../src/legacy/use-gate.ts'
import { createWorkspaceMutationOwner } from '../src/workspace-mutation.ts'
import { coldLegacyFixture } from './fixtures/cold-selected-legacy.ts'

afterEach(() => { io.close = undefined; vi.restoreAllMocks() })
const captured = { sessionId: 'source', callId: 'one', label: 'one', text: 'original needle', complete: true }

it('keeps a genuine newly registered transfer scope through first resume drift while explicit clear revokes it', async () => {
  const f = await coldLegacyFixture(), service = createContextOutputService({ root: f.root, workspaceId: 'w', requireObservedLegacyRecipients: true, config: { enabled: true } }), transfer = io.transfer!
  try {
    await service.read({ sessionId: 'source' }, { refId: f.ref.id })
    const target = await inspectColdSelectedTarget(f.coordinator, f.route)
    if (target.kind !== 'qualification-required') throw Error('Cold fixture unavailable')
    await useColdSelectedTarget(f.coordinator, target.target, async input => {
      const cold = captureOriginalColdObservation(f.coordinator, input)
      const scope = transfer.register({ invocation: cold.facts.invocation, facts: cold.facts, sourceSessionId: 'source', targetView: cold.view,
        target: { available: () => true, assertCurrent() {}, sourceId: () => f.sourceId },
        source: { view: cold.view, assertCurrent() {}, read() { throw Error('Fresh passive scope must not capture a source') } },
      })
      // This second original token reaches the actual native IndexUse capture,
      // then refuses before source authorization or publication. Its partial
      // dependency is historical even though it never qualifies a result.
      const historical = transfer.register({ invocation: cold.facts.invocation, facts: cold.facts, sourceSessionId: 'source', targetView: cold.view,
        target: { available: () => true, assertCurrent() {}, sourceId() { throw Error('Stop after original currency capture') } },
        source: { view: cold.view, assertCurrent() {}, read: () => ({ sessionId: 'source', sourceId: f.sourceId, assertCurrent() {}, localVisible: () => false, anchorVisible: () => false }) },
      })
      expect(await transfer.confirm(historical)).toEqual({ kind: 'blocked', reason: 'unavailable' })
      expect(await transfer.reconcile(historical)).toEqual({ kind: 'blocked', reason: 'unknown' })
      expect(await transfer.reconcile(scope)).toEqual({ kind: 'blocked', reason: 'unknown' })
      await f.service.grant({ sessionId: 'source' }, [f.ref.id], 'remote')
      await service.read({ sessionId: 'source' }, { refId: f.ref.id })
      // Still has no original captured store/index currency; no new effects.
      expect(await transfer.reconcile(scope)).toEqual({ kind: 'blocked', reason: 'unknown' })
      expect(await transfer.reconcile(historical)).toEqual({ kind: 'blocked', reason: 'unavailable' })
      await service.clear('target')
      expect(await transfer.reconcile(scope)).toEqual({ kind: 'blocked', reason: 'unavailable' })
      await transfer.closeScope(scope)
      await transfer.closeScope(historical)
      await expect(transfer.closeScope({ ...scope })).rejects.toThrow(/Foreign/)
    })
  } finally { await service.close(); await f.close(); await rm(f.root, { recursive: true, force: true }) }
})

it('allows a fresh cold acquisition after resume drift but revokes historical proofs and pending owners on real clear', async () => {
  const f = await coldLegacyFixture()
  try {
    // Establish this store's original idle witness before the remote mutation.
    expect((await f.service.read({ sessionId: 'source' }, { refId: f.ref.id })).text).toBe('original legacy bytes')
    const target = await inspectColdSelectedTarget(f.coordinator, f.route)
    if (target.kind !== 'qualification-required') throw Error('Cold fixture unavailable')
    let first!: ReturnType<typeof acquireColdSelectedQualification>, second!: typeof first
    await useColdSelectedTarget(f.coordinator, target.target, async cold => {
      first = acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId)
      await first.qualify(); first.sealWhileActive()
    })
    await first.settle(); first.assertSettledCurrent()
    const remote = createContextOutputService({ root: f.root, workspaceId: 'w', config: { enabled: true } })
    try { await remote.grant({ sessionId: 'source' }, [f.ref.id], 'remote') } finally { await remote.close() }
    expect((await f.service.read({ sessionId: 'remote' }, { refId: f.ref.id })).text).toBe('original legacy bytes')
    expect(() => first.assertSettledCurrent()).toThrow()
    await useColdSelectedTarget(f.coordinator, target.target, async cold => {
      second = acquireColdSelectedQualification(f.service, f.coordinator, cold, f.sourceId)
      await f.service.clear('target')
      expect(() => second.qualify()).toThrow(/revoked/)
    })
    await first.close(); await second.close()
  } finally { await f.close(); await rm(f.root, { recursive: true, force: true }) }
})

it('releases the original lifetime at last use and resumes the same store without population reconstruction', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'idle-store-'))
  const opened = vi.spyOn(ContextStore.prototype, 'open'), rebuilt = vi.spyOn(LegacyIndexLifecycle.prototype, 'rebuild')
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const ref = (await service.capture(captured))!
    const original = (opened.mock.contexts[0]! as ContextStore)
    expect(original.lifetimeSettled()).toBe(true)
    const initialRebuilds = rebuilt.mock.calls.length, bodyReads = io.bodyReads
    const index = original as unknown as { index: { handle: { generation: symbol } } }
    let previous = index.index.handle.generation
    for (let i = 0; i < 2; i++) {
      expect((await service.read({ sessionId: 'source' }, { refId: ref.id })).text).toBe('original needle')
      expect((await service.search({ sessionId: 'source' }, { query: 'needle' })).hits).toHaveLength(1)
      expect(original.lifetimeSettled()).toBe(true)
      expect(index.index.handle.generation).not.toBe(previous); previous = index.index.handle.generation
    }
    expect(opened).toHaveBeenCalledTimes(1)
    expect(rebuilt.mock.calls.length).toBe(initialRebuilds)
    expect(opened.mock.contexts.every(value => value === original)).toBe(true)
    expect(io.bodyReads - bodyReads).toBe(4) // Requested body once per read/search; no population body scan.
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps the shared use until the final concurrent policy await leaves, then joins one idle retirement', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'idle-shared-'))
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let arrivals = 0
  const opened = vi.spyOn(ContextStore.prototype, 'open'), idle = vi.spyOn(ContextStore.prototype, 'quiesce')
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, authorize: async () => { const position = arrivals++; if (arrivals === 2) entered.resolve(); await (position === 0 ? first : second).promise; return true } })
  try {
    const ref = (await service.capture(captured))!, original = (opened.mock.contexts[0]! as ContextStore), before = idle.mock.calls.length
    const a = service.read({ sessionId: 'one' }, { refId: ref.id }), b = service.read({ sessionId: 'two' }, { refId: ref.id })
    await entered.promise
    first.resolve(); expect((await a).text).toBe('original needle')
    expect(original.lifetimeSettled()).toBe(false); expect(idle.mock.calls.length).toBe(before)
    second.resolve(); expect((await b).text).toBe('original needle')
    expect(original.lifetimeSettled()).toBe(true); expect(idle.mock.calls.length).toBe(before + 1)
  } finally { first.resolve(); second.resolve(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('reacquires the lifetime for the actual constructor-owned passive transfer continuation', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'idle-passive-continuation-'))
  const opened = vi.spyOn(ContextStore.prototype, 'open'), service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    await service.capture(captured)
    const original = opened.mock.contexts[0]! as ContextStore
    expect(original.lifetimeSettled()).toBe(true)
    await io.passive!(original, async (_signal, current) => { expect(current).toBe(original); expect(current.lifetimeSettled()).toBe(false) })
    expect(original.lifetimeSettled()).toBe(true)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('retains exact falsey index retirement (consumed=%s) instead of reopening from an empty cache', async consumed => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'idle-index-debt-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } }), closed = DatabaseSync.prototype.close
  const opened = vi.spyOn(ContextStore.prototype, 'open'), rebuild = vi.spyOn(LegacyIndexLifecycle.prototype, 'rebuild')
  let original: DatabaseSync | undefined, closes = 0
  const fault = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    original ??= this; expect(this).toBe(original)
    if (++closes === 1) { if (consumed) closed.call(this); throw undefined }
    return closed.call(this)
  })
  try {
    await expect(service.capture(captured)).rejects.toBe(undefined)
    const store = (opened.mock.contexts[0]! as ContextStore), before = rebuild.mock.calls.length
    expect(store.lifetimeSettled()).toBe(false)
    if (consumed) {
      await expect(service.close()).rejects.toBe(undefined)
      await expect(service.close()).rejects.toBe(undefined)
      expect(closes).toBe(1); expect(store.lifetimeSettled()).toBe(false)
    } else {
      await service.close(); expect(closes).toBe(2); expect(store.lifetimeSettled()).toBe(true)
    }
    expect(rebuild.mock.calls.length).toBe(before)
  } finally { fault.mockRestore(); if (!consumed) await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('settles original idle retirement before a new query, consumed=%s', async consumed => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'idle-query-retry-'))
  const path = locking.lockPathFor(root, 'context-output-legacy:w')
  const acquire = locking.acquireSessionLock, close = DatabaseSync.prototype.close
  let original: DatabaseSync | undefined, originalLease: locking.SessionLock | undefined
  let originalCloses = 0, acquisitions = 0
  const acquisition = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
    if (options.lockPath === path && ++acquisitions > 1) {
      expect(originalLease?.held).toBe(false)
      expect(originalCloses).toBe(2)
    }
    const lease = await acquire(options)
    if (options.lockPath === path) originalLease ??= lease
    return lease
  })
  const fault = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
    original ??= this
    if (this !== original) return close.call(this)
    if (++originalCloses === 1) { if (consumed) close.call(this); throw undefined }
    return close.call(this)
  })
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    await expect(service.capture(captured)).rejects.toBeUndefined()
    if (consumed) {
      await expect(service.search({ sessionId: captured.sessionId }, { query: 'needle' })).rejects.toBeUndefined()
      await expect(service.close()).rejects.toBeUndefined()
      expect(originalCloses).toBe(1)
      expect(acquisitions).toBe(1)
    } else {
      const result = await service.search({ sessionId: captured.sessionId }, { query: 'needle' })
      expect(result.hits).toHaveLength(1)
      expect(result.hits[0]!.ref.sessionId).toBe(captured.sessionId)
      expect(originalCloses).toBe(2)
      expect(acquisitions).toBe(2)
    }
  } finally {
    fault.mockRestore()
    acquisition.mockRestore()
    if (!consumed) await service.close()
    if (originalLease?.held) await originalLease.release()
  }
})

it.each([false, true])('retains exact falsey lifetime retirement (consumed=%s) and never reacquires it as cleanup', async consumed => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'idle-life-debt-'))
  const path = locking.lockPathFor(root, 'context-output-legacy:w'), acquire = locking.acquireSessionLock
  let acquisitions = 0, releases = 0, native: locking.SessionLock | undefined
  const acquisition = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
    const lease = await acquire(options)
    if (options.lockPath !== path) return lease
    acquisitions++; native = lease
    return { ...lease, get held() { return lease.held }, async release() {
      if (++releases === 1) { if (consumed) await lease.release(); throw null }
      await lease.release()
    } }
  })
  const opened = vi.spyOn(ContextStore.prototype, 'open'), service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    await expect(service.capture(captured)).rejects.toBe(null)
    const store = (opened.mock.contexts[0]! as ContextStore)
    expect(store.lifetimeSettled()).toBe(false)
    if (consumed) { await expect(service.close()).rejects.toBe(null); await expect(service.close()).rejects.toBe(null); expect(releases).toBe(1) }
    else { await service.close(); expect(releases).toBe(2); expect(store.lifetimeSettled()).toBe(true) }
    expect(acquisitions).toBe(1)
  } finally { acquisition.mockRestore(); if (native?.held) await native.release(); if (!consumed) await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('retains the exact idle witness reader (consumed=%s) until original cleanup acknowledges', async consumed => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'idle-reader-debt-'))
  const opened = vi.spyOn(ContextStore.prototype, 'open'), service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  let attempts = 0
  io.close = async (path, close) => {
    if (path.endsWith('index.sqlite')) {
      if (++attempts === 1) { if (consumed) await close(); throw false }
    }
    await close()
  }
  try {
    await expect(service.capture(captured)).rejects.toBe(false)
    const store = (opened.mock.contexts[0]! as ContextStore)
    expect(store.lifetimeSettled()).toBe(false)
    if (consumed) { await expect(service.close()).rejects.toBe(false); await expect(service.close()).rejects.toBe(false); expect(attempts).toBe(1) }
    else { await service.close(); expect(attempts).toBe(2); expect(store.lifetimeSettled()).toBe(true) }
  } finally { io.close = undefined; if (!consumed) await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('passively includes global expired owners and validates real V2 authority before source-only clear', async () => {
  const f = await coldLegacyFixture(), gate = createLegacyUseGate(), owner = createWorkspaceMutationOwner({ root: f.root, workspaceId: 'w' })
  const store = new ContextStore(f.root, 'w', owner, gate.assertLease)
  const open = vi.spyOn(store, 'open'), rebuild = vi.spyOn(LegacyIndexLifecycle.prototype, 'rebuild'), body = vi.spyOn(store, 'verifyBody')
  const clock = Date.now.bind(Date), advance = f.ref.expiresAt + 1 - clock()
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock() + advance)
  try {
    const before = await readFile(join(f.directory, 'revoke.1'))
    const counts = { bodyReads: io.bodyReads, bodyOpens: io.bodyOpens, indexOpens: io.indexOpens }
    await gate.exclusive(undefined, async lease => {
      await store.acquireLifetime()
      const inventory = await owner.mutate(turn => store.passiveInventory(turn, 'unrelated'))
      expect(inventory.targets).toEqual(['source', 'target', 'unrelated'])
      expect(inventory.expired).toEqual([f.ref.id])
      expect(open).not.toHaveBeenCalled(); expect(rebuild).not.toHaveBeenCalled(); expect(body).not.toHaveBeenCalled()
      expect({ bodyReads: io.bodyReads, bodyOpens: io.bodyOpens, indexOpens: io.indexOpens }).toEqual(counts)
      expect(await readFile(join(f.directory, 'revoke.1'))).toEqual(before)
      await store.quiesce(lease)
    })
    await f.service.clear('unrelated')
    await expect(readFile(join(store.directory, 'artifacts', f.ref.id + '.json'))).rejects.toHaveProperty('code', 'ENOENT')
  } finally { now.mockRestore(); await gate.exclusive(undefined, lease => store.close(lease)); await owner.close(); await f.close(); await rm(f.root, { recursive: true, force: true }) }
})

it('invalidates an exactly same-size rewritten SQLite cache despite restored timestamps and rebuilds only that changed generation', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'idle-cache-change-'))
  const opened = vi.spyOn(ContextStore.prototype, 'open'), rebuilt = vi.spyOn(LegacyIndexLifecycle.prototype, 'rebuild')
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const ref = (await service.capture(captured))!, path = join((opened.mock.contexts[0]! as ContextStore).directory, 'index.sqlite'), before = await stat(path)
    const db = new DatabaseSync(path)
    try { db.prepare('UPDATE refs SET complete=0 WHERE id=?').run(ref.id) } finally { db.close() }
    expect((await stat(path)).size).toBe(before.size)
    await utimes(path, before.atime, before.mtime)
    const count = rebuilt.mock.calls.length
    expect((await service.search({ sessionId: 'source' }, { query: 'needle' })).hits).toHaveLength(1)
    expect(rebuilt.mock.calls.length).toBe(count + 1)
    expect(opened).toHaveBeenCalledTimes(1)
    const again = rebuilt.mock.calls.length
    expect((await service.search({ sessionId: 'source' }, { query: 'needle' })).hits).toHaveLength(1)
    expect(rebuilt.mock.calls.length).toBe(again)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('rejects same-size remote membership changes before returning cached authorization and still hashes requested bodies', async () => {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'idle-remote-'))
  const opened = vi.spyOn(ContextStore.prototype, 'open')
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const ref = (await service.capture(captured))!, directory = (opened.mock.contexts[0]! as ContextStore).directory
    // A separate logical original service owns the workspace while this one is idle.
    const remote = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    try { await remote.grant({ sessionId: 'source' }, [ref.id], 'remote') } finally { await remote.close() }
    expect((await service.read({ sessionId: 'remote' }, { refId: ref.id })).text).toBe('original needle')
    const path = join(directory, 'owners', ref.id + '.json'), original = await readFile(path)
    const changed = Buffer.from(original.toString().replace('remote', 'absent'))
    expect(changed.length).toBe(original.length)
    await writeFile(path, changed); await utimes(path, new Date(0), new Date(0))
    await expect(service.read({ sessionId: 'remote' }, { refId: ref.id })).rejects.toThrow(/unavailable|unauthorized/)
    await writeFile(join(directory, 'blobs', ref.id + '.txt'), 'corrupted text!')
    await expect(service.read({ sessionId: 'source' }, { refId: ref.id })).rejects.toThrow(/integrity/)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
