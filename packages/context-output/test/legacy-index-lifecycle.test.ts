import { expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ beforeReadDirectory: undefined as ((path: string) => Promise<void>) | undefined, beforeAccess: undefined as ((path: string) => Promise<void>) | undefined, beforeRemove: undefined as ((path: string) => Promise<void>) | undefined, afterRename: undefined as ((path: string) => Promise<void>) | undefined, afterWrite: undefined as ((path: string) => Promise<void>) | undefined, opened: undefined as ((handle: import('node:fs/promises').FileHandle, path: string) => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readdir: async (...args: Parameters<typeof fs.readdir>) => { await io.beforeReadDirectory?.(String(args[0])); return fs.readdir(...args) }, access: async (...args: Parameters<typeof fs.access>) => { await io.beforeAccess?.(String(args[0])); return fs.access(...args) }, open: async (...args: Parameters<typeof fs.open>) => { const handle = await fs.open(...args); io.opened?.(handle, String(args[0])); return handle }, writeFile: async (...args: Parameters<typeof fs.writeFile>) => { const value = await fs.writeFile(...args); await io.afterWrite?.(String(args[0])); return value }, rm: async (...args: Parameters<typeof fs.rm>) => { await io.beforeRemove?.(String(args[0])); return fs.rm(...args) }, rename: async (...args: Parameters<typeof fs.rename>) => { const value = await fs.rename(...args); await io.afterRename?.(String(args[1])); return value } }
})
import { mkdtemp, readFile, readdir, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createContextOutputService } from '../src/index.ts'
import { ContextStore, digest, referenceId } from '../src/store.ts'
import { createLegacyUseGate } from '../src/legacy/use-gate.ts'
import { createWorkspaceMutationOwner } from '../src/workspace-mutation.ts'
import { LegacyIndexLifecycle, type IndexUse } from '../src/legacy/index-lifecycle.ts'
import { physicalBytes } from '../src/artifact/quota.ts'
import * as pages from '../src/legacy/fork-pages.ts'
import { legacyFixture } from './legacy-fork-fixture.ts'
import { OwnerLedger } from '../src/legacy/owner-ledger.ts'
import * as locking from '@i-harness/fs-lock'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { recordHash } from '../src/legacy/fork-codec.ts'
import { pageName, walkPages } from '../src/legacy/fork-pages.ts'
import type { LegacyRoot, LegacyPage } from '../src/legacy/fork-types.ts'

const input = { sessionId: 's', callId: 'c', label: 'saved', text: 'original needle', complete: true }

it('keeps the unused owners schema empty through actual capture and grant', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-owner-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const ref = await service.capture(input)
    if (!ref) throw Error('fixture refused')
    await service.grant({ sessionId: 's' }, [ref.id], 'target')
    const db = new DatabaseSync(resolve(new ContextStore(root, 'w').directory, 'index.sqlite'))
    try { expect(db.prepare('SELECT COUNT(*) AS count FROM owners').get()!.count).toBe(0) }
    finally { db.close() }
    expect((await service.read({ sessionId: 'target' }, { refId: ref.id })).text).toBe(input.text)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('holds the actual shared query scope across policy awaits before admitting capture', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-held-'))
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, authorize: async () => { entered.resolve(); await resume.promise; return true } })
  try {
    await service.capture(input)
    const put = vi.spyOn(ContextStore.prototype, 'put')
    const searching = service.search({ sessionId: 'reader' }, { query: 'needle' })
    await entered.promise
    const capturing = service.capture({ ...input, callId: 'second' })
    await new Promise(settle => setTimeout(settle, 30))
    expect(put).not.toHaveBeenCalled()
    resume.resolve()
    expect((await searching).hits).toHaveLength(1)
    expect(await capturing).toBeDefined()
    put.mockRestore()
  } finally { resume.resolve(); vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})


it('rejects actual foreign creating-gate leases and expired generations without a permissive scope', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-generation-')), gate = createLegacyUseGate(), other = createLegacyUseGate()
  const owner = createWorkspaceMutationOwner({ root, workspaceId: 'w' }), store = new ContextStore(root, 'w', owner, gate.assertLease)
  let stale!: IndexUse
  try {
    await gate.exclusive(undefined, async lease => {
      await store.acquireLifetime()
      await owner.mutate(async turn => { await store.open(turn, lease, 1024 * 1024, 'query'); await store.ensureIndex(turn, lease, 1024 * 1024) })
      stale = store.indexUse(lease)
      expect(stale.get('SELECT COUNT(*) AS count FROM refs')!.count).toBe(0)
      await other.exclusive(undefined, async foreign => {
        expect(() => store.indexUse(foreign)).toThrow(/foreign/)
        await expect(owner.mutate(turn => store.ensureIndex(turn, foreign, 1024 * 1024))).rejects.toThrow(/foreign/)
      })
      await owner.mutate(async turn => { await store.clear(turn, lease, 1024 * 1024); expect(stale.get('SELECT COUNT(*) AS count FROM refs')!.count).toBe(0) })
    })
    expect(() => stale.get('SELECT 1')).toThrow(/Stale|foreign/)
    await gate.exclusive(undefined, async lease => {
      const current = store.indexUse(lease)
      await owner.mutate(async turn => {
        const lifecycle = (store as unknown as { index: LegacyIndexLifecycle }).index
        lifecycle.invalidate(Error('actual original change'))
        await store.ensureIndex(turn, lease, 1024 * 1024)
      })
      expect(() => current.get('SELECT 1')).toThrow(/Stale/)
    })
  } finally { await gate.exclusive(undefined, lease => store.close(lease)); await owner.close(); await rm(root, { recursive: true, force: true }) }
})

it('completes actual canonical cleanup with an explicit unavailable index and preserves direct survivor reads', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-survivor-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const removed = await service.capture(input), survivor = await service.capture({ ...input, sessionId: 'other', callId: 'survivor' })
    if (!removed || !survivor) throw Error('fixture refused')
    const directory = new ContextStore(root, 'w').directory, full = await physicalBytes(directory)
    await service.configure({ maxDiskBytes: full })
    const status = await service.clear('s')
    expect(status).toMatchObject({ state: 'error', results: 1 })
    expect(status.error).toMatch(/cleanup completed.*index unavailable/i)
    await expect(stat(resolve(directory, 'blobs', removed.id + '.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await service.read({ sessionId: 'other' }, { refId: survivor.id })).text).toBe(input.text)
    await expect(service.search({ sessionId: 'other' }, { query: 'needle' })).rejects.toThrow(/index unavailable/i)
    expect(await physicalBytes(directory)).toBeLessThanOrEqual(full)
    await service.configure({ maxDiskBytes: full + 128 * 1024 })
    expect((await service.search({ sessionId: 'other' }, { query: 'needle' })).hits.map(hit => hit.ref.id)).toEqual([survivor.id])
    expect(service.status().error).toBeUndefined()
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['blobs', 'artifacts'] as const)('fences original map visibility before a failed %s unlink and cold finishes body before manifest', async kind => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-canonical-cut-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  let cold: ReturnType<typeof createContextOutputService> | undefined
  try {
    const ref = await service.capture(input)
    if (!ref) throw Error('fixture refused')
    const directory = new ContextStore(root, 'w').directory, fault = new Error('original canonical unlink failed')
    io.beforeRemove = async path => {
      if (path === resolve(directory, kind, ref.id + (kind === 'blobs' ? '.txt' : '.json'))) {
        expect(service.status().results).toBe(0)
        expect(JSON.parse(await readFile(resolve(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual([])
        throw fault
      }
    }
    await expect(service.clear('s')).rejects.toBe(fault)
    expect(service.status().results).toBe(0)
    expect(await stat(resolve(directory, 'artifacts', ref.id + '.json'))).toBeDefined()
    if (kind === 'artifacts') await expect(stat(resolve(directory, 'blobs', ref.id + '.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    io.beforeRemove = undefined
    await service.close()
    const order: string[] = []
    io.beforeRemove = async path => { if (path.includes(ref.id) && !path.includes('.tmp')) order.push(path) }
    cold = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    await cold.clear('unrelated')
    expect(order.findIndex(path => path.includes('blobs'))).toBeLessThan(order.findIndex(path => path.includes('artifacts')))
    await expect(cold.read({ sessionId: 's' }, { refId: ref.id })).rejects.toThrow(/unavailable/)
  } finally { io.beforeRemove = undefined; await cold?.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('never revives cached owners after an actual tombstone rename response is lost', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-tombstone-cut-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const ref = await service.capture(input)
    if (!ref) throw Error('fixture refused')
    const directory = new ContextStore(root, 'w').directory, fault = new Error('original tombstone response lost')
    io.afterRename = async path => { if (path === resolve(directory, 'owners', ref.id + '.json')) throw fault }
    await expect(service.clear('s')).rejects.toBe(fault)
    expect(service.status().results).toBe(0)
    expect(JSON.parse(await readFile(resolve(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual([])
    await expect(service.read({ sessionId: 's' }, { refId: ref.id })).rejects.toThrow(/unavailable/)
    io.afterRename = undefined
    await service.clear('s')
    expect(service.status().results).toBe(0)
  } finally { io.afterRename = undefined; await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('restores every ordinary original ledger when cancellation reaches the final actual disk check', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-grant-final-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } }), controller = new AbortController()
  try {
    const ref = await service.capture(input)
    if (!ref) throw Error('fixture refused')
    const path = resolve(new ContextStore(root, 'w').directory, 'owners', ref.id + '.json'), inventory = ContextStore.prototype.diskBytes
    const cut = vi.spyOn(ContextStore.prototype, 'diskBytes').mockImplementation(async function(this: ContextStore, ...args) {
      const actual = await inventory.apply(this, args)
      if (JSON.parse(await readFile(path, 'utf8')).includes('target')) controller.abort()
      return actual
    })
    await expect(service.grant({ sessionId: 's', signal: controller.signal }, [ref.id], 'target')).rejects.toMatchObject({ name: 'AbortError' })
    cut.mockRestore()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(['s'])
    await expect(service.read({ sessionId: 'target' }, { refId: ref.id })).rejects.toThrow(/unauthorized/)
    expect((await service.read({ sessionId: 's' }, { refId: ref.id })).text).toBe(input.text)
  } finally { vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})


it('conditionally uses the exact prospective allowance with one producer while incremental admission stays incremental', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-prospective-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true, maxDiskBytes: 128 * 1024 } })
  const admit = LegacyIndexLifecycle.prototype.admitCapture, begin = LegacyIndexLifecycle.prototype.beginCaptureReplacement
  const admissions: string[] = [], allocations: number[] = []
  let current: ContextStore | undefined, prospective: string | undefined, producerCalls = 0
  const put = ContextStore.prototype.put
  const storeSpy = vi.spyOn(ContextStore.prototype, 'put').mockImplementation(function(this: ContextStore, ...args) { current = this; return put.apply(this, args) })
  const admissionSpy = vi.spyOn(LegacyIndexLifecycle.prototype, 'admitCapture').mockImplementation(async function(this: LegacyIndexLifecycle, ...args) {
    const result = await admit.apply(this, args); admissions.push(result.kind); allocations.push(args[3]); return result
  })
  const fallbackSpy = vi.spyOn(LegacyIndexLifecycle.prototype, 'beginCaptureReplacement').mockImplementation(async function(this: LegacyIndexLifecycle, ...args) {
    prospective = args[5].ref.id
    const scope = await begin.apply(this, args)
    expect(current!.get(prospective)).toBeUndefined()
    expect(() => current!.indexUse(args[1])).toThrow(/unavailable/)
    const expected = args[5].bytes.length + Buffer.byteLength(JSON.stringify([args[5].ref.sessionId])) + Buffer.byteLength(JSON.stringify({ ref: args[5].ref }))
    expect(args[3]).toBe(expected)
    expect(await physicalBytes(current!.directory)).toBeLessThanOrEqual(args[2] - args[3])
    return scope
  })
  try {
    const seed = await service.capture(input, undefined, async () => { producerCalls++; return { text: input.text, complete: true } })
    expect(seed).toMatchObject({ complete: true, bytes: Buffer.byteLength(input.text), originalBytes: Buffer.byteLength(input.text) })
    expect(admissions).toEqual(['fresh']); expect(fallbackSpy).toHaveBeenCalledTimes(1); expect(producerCalls).toBe(1)
    await service.configure({ maxDiskBytes: 1024 * 1024 })
    expect(await service.capture({ ...input, callId: 'incremental' })).toBeDefined()
    expect(admissions).toEqual(['fresh', 'incremental']); expect(fallbackSpy).toHaveBeenCalledTimes(1)
    expect(allocations.every(value => Number.isSafeInteger(value) && value > 0)).toBe(true)
  } finally { storeSpy.mockRestore(); admissionSpy.mockRestore(); fallbackSpy.mockRestore(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['retired', 'schema', 'existing-row', 'prospective-row', 'body', 'owners', 'manifest', 'before-commit', 'after-commit', 'final-inventory'] as const)('discards the actual prospective capture after the %s cut without producer replay or phantom success', async phase => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-prospective-cut-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  let cold: ReturnType<typeof createContextOutputService> | undefined
  let active = false, candidate = '', rows = 0, committed = false, injected = false, producers = 0
  const fault = new Error(`prospective ${phase} failure`)
  const fail = () => { if (!injected) { injected = true; throw fault } }
  const begin = LegacyIndexLifecycle.prototype.beginCaptureReplacement, exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare, inventory = ContextStore.prototype.diskBytes
  try {
    const seed = await service.capture(input)
    if (!seed) throw Error('fixture refused')
    const directory = new ContextStore(root, 'w').directory
    await service.configure({ maxDiskBytes: await physicalBytes(directory) + 128 * 1024 })
    const fallback = vi.spyOn(LegacyIndexLifecycle.prototype, 'beginCaptureReplacement').mockImplementation(async function(this: LegacyIndexLifecycle, ...args) {
      active = true; candidate = args[5].ref.id; return begin.apply(this, args)
    })
    const nativeExec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
      if (active && phase === 'retired' && sql.startsWith('PRAGMA journal_mode=')) fail()
      if (active && phase === 'before-commit' && sql === 'COMMIT') fail()
      const value = exec.call(this, sql)
      if (active && phase === 'schema' && sql.startsWith('CREATE TABLE IF NOT EXISTS refs')) fail()
      if (active && sql === 'COMMIT') { committed = true; if (phase === 'after-commit') fail() }
      return value
    })
    const nativePrepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql)
      if (active && sql === 'INSERT INTO refs VALUES (?,?,?)') {
        const run = statement.run.bind(statement)
        statement.run = ((...args: unknown[]) => {
          const value = Reflect.apply(run, statement, args); rows++
          if (phase === 'existing-row' && rows === 1 || phase === 'prospective-row' && String(args[0]) === candidate) fail()
          return value
        }) as typeof statement.run
      }
      return statement
    })
    io.afterWrite = async path => { if (active && phase === 'body' && path.endsWith(candidate + '.txt')) fail() }
    io.afterRename = async path => { if (active && (phase === 'owners' && path === resolve(directory, 'owners', candidate + '.json') || phase === 'manifest' && path === resolve(directory, 'artifacts', candidate + '.json'))) fail() }
    const finalCheck = vi.spyOn(ContextStore.prototype, 'diskBytes').mockImplementation(async function(this: ContextStore, ...args) {
      const bytes = await inventory.apply(this, args)
      if (active && phase === 'final-inventory' && committed) fail()
      return bytes
    })
    await expect(service.capture({ ...input, callId: 'prospective' }, undefined, async () => { producers++; return { text: 'prospective needle', complete: true } })).rejects.toBe(fault)
    expect(injected).toBe(true); expect(producers).toBe(1); expect(fallback).toHaveBeenCalledTimes(1)
    active = false; io.afterWrite = undefined; io.afterRename = undefined
    nativeExec.mockRestore(); nativePrepare.mockRestore(); finalCheck.mockRestore(); fallback.mockRestore()
    expect(service.status().results).toBe(1)
    expect((await service.read({ sessionId: 's' }, { refId: seed.id })).text).toBe(input.text)
    await expect(service.read({ sessionId: 's' }, { refId: candidate })).rejects.toThrow(/unavailable/)
    await expect(stat(resolve(directory, 'artifacts', candidate + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await service.close()
    cold = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    expect((await cold.search({ sessionId: 's' }, { query: 'needle' })).hits.map(hit => hit.ref.id)).toEqual([seed.id])
    expect(cold.status().results).toBe(1)
  } finally { active = false; io.afterWrite = undefined; io.afterRename = undefined; vi.restoreAllMocks(); await cold?.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains the exact native close and unlink intent after canonical cleanup until explicit original retirement succeeds', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-native-debt-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const close = DatabaseSync.prototype.close, fault = new Error('original derived close refused')
  let original: DatabaseSync | undefined, attempts = 0
  try {
    await service.capture(input)
    const directory = new ContextStore(root, 'w').directory, path = resolve(directory, 'index.sqlite')
    const native = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function(this: DatabaseSync) {
      original ??= this; expect(this).toBe(original)
      if (++attempts === 1) throw fault
      return close.call(this)
    })
    await expect(service.clear('s')).rejects.toBe(fault)
    expect(attempts).toBe(1); expect(original?.isOpen).toBe(true); expect(service.status().results).toBe(0)
    expect(await stat(path)).toBeDefined()
    // A permanent close must finish the prior remove disposition, not retain it.
    await service.close()
    expect(attempts).toBe(2); expect(original?.isOpen).toBe(false)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    native.mockRestore()
  } finally { vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps exact derived unlink debt after confirmed native close and does not repeat that close', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-unlink-debt-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    await service.capture(input)
    const path = resolve(new ContextStore(root, 'w').directory, 'index.sqlite'), fault = new Error('original derived unlink refused')
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    io.beforeRemove = async value => { if (value === path) throw fault }
    await expect(service.clear('s')).rejects.toBe(fault)
    expect(close).toHaveBeenCalledTimes(1); expect(await stat(path)).toBeDefined()
    io.beforeRemove = undefined
    await service.close()
    expect(close).toHaveBeenCalledTimes(1)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    close.mockRestore()
  } finally { io.beforeRemove = undefined; vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})


it('rejects same-gate policy reentry promptly while preserving the original query and managed access', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-reentry-'))
  let callback = async () => {}
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, authorize: async () => { await callback(); return true } })
  try {
    await service.capture(input)
    const managed = service.registerResultScope({ operationId: 'managed', sessionId: 's', callId: 'managed' }, () => true)
    const sink = await service.beginResult(managed, 'text-utf8-v1'); await sink.write(Buffer.from('managed body'))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture refused')
    callback = async () => {
      await expect(service.search({ sessionId: 'nested' }, { query: 'needle' })).rejects.toThrow(/reentry/)
      expect((await service.readResult({ sessionId: 's' }, { ref: saved.ref })).data).toEqual({ kind: 'text', text: 'managed body' })
    }
    expect((await service.search({ sessionId: 'reader' }, { query: 'needle' })).hits).toHaveLength(1)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('admits a queued writer before a later pure search after the original shared consumer settles', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-fairness-')), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const events: string[] = []
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, authorize: async ({ sessionId }) => {
    if (sessionId === 'first') { entered.resolve(); await resume.promise }
    else events.push('later-reader')
    return true
  } })
  try {
    await service.capture(input)
    const put = ContextStore.prototype.put
    const writer = vi.spyOn(ContextStore.prototype, 'put').mockImplementation(function(this: ContextStore, ...args) { events.push('writer'); return put.apply(this, args) })
    const first = service.search({ sessionId: 'first' }, { query: 'needle' })
    await entered.promise
    const writing = service.capture({ ...input, callId: 'queued' })
    await new Promise(settle => setTimeout(settle, 10))
    const later = service.search({ sessionId: 'later' }, { query: 'needle' })
    await new Promise(settle => setTimeout(settle, 10)); expect(events).toEqual([])
    resume.resolve()
    expect((await first).hits).toHaveLength(1); expect(await writing).toBeDefined(); expect((await later).hits).toHaveLength(2)
    expect(events[0]).toBe('writer'); writer.mockRestore()
  } finally { resume.resolve(); vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

// These native fork, cancellation and cleanup controls measured 5.1–5.4s.
it('holds actual hint proof and its native generation until cancellation and original callback cleanup settle', async () => {
  const f = await legacyFixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  let reading: Promise<unknown> | undefined, clearing: Promise<unknown> | undefined
  const rowProof = pages.rowProof
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation(), proof = vi.spyOn(pages, 'rowProof').mockImplementation(async (...args) => { const row = await rowProof(...args); entered.resolve(); await resume.promise; return row })
    reading = f.service().searchLegacyObserved({ sessionId: 'target' }, { query: 'VISIBLE' }, observation)
    const outcome = expect(reading).rejects.toThrow()
    await entered.promise
    const put = vi.spyOn(ContextStore.prototype, 'put'), close = vi.spyOn(DatabaseSync.prototype, 'close')
    let settled = false
    clearing = f.service().clear('target').then(value => { settled = true; return value })
    await new Promise(settle => setTimeout(settle, 20))
    expect(settled).toBe(false); expect(close).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled()
    resume.resolve(); await outcome; await clearing
    proof.mockRestore(); close.mockRestore(); put.mockRestore()
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
  } finally { resume.resolve(); await Promise.allSettled([reading, clearing]); vi.restoreAllMocks(); await f.close() }
}, 15000)

it('keeps one exclusive preparation generation across actual reset, stage and ready while clear waits', async () => {
  const f = await legacyFixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  let preparing: Promise<unknown> | undefined, clearing: Promise<unknown> | undefined
  try {
    expect((await f.run()).kind).toBe('ready')
    const reset = ContextStore.prototype.resetLegacyIndex, sourceCalls = f.sourceCalls()
    const held = vi.spyOn(ContextStore.prototype, 'resetLegacyIndex').mockImplementation(async function(this: ContextStore, ...args) {
      await reset.apply(this, args); args[2].assertCurrent(); entered.resolve(); await resume.promise; args[2].assertCurrent()
    })
    preparing = f.run(true)
    await entered.promise
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    let settled = false
    clearing = f.service().clear('unrelated').then(value => { settled = true; return value })
    await new Promise(settle => setTimeout(settle, 20)); expect(settled).toBe(false); expect(close).not.toHaveBeenCalled()
    resume.resolve(); await preparing; await clearing
    held.mockRestore(); close.mockRestore()
    expect(f.sourceCalls()).toBe(sourceCalls)
    expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, await f.observation())).text).toContain('VISIBLE')
  } finally { resume.resolve(); await Promise.allSettled([preparing, clearing]); vi.restoreAllMocks(); await f.close() }
}, 15000)

// Actual fork, expiry, quota reconfiguration and native recapture take ~6.5s
// in isolation; this one multi-phase fixture needs more than the 5s default.
it('describes and funds the actual tracked recapture allocation without reviving historical target authority', async () => {
  const f = await legacyFixture(), clock = vi.spyOn(Date, 'now')
  try {
    expect((await f.run()).kind).toBe('ready')
    clock.mockReturnValue(f.visible.expiresAt + 1)
    await f.service().clear('unrelated')
    const directory = new ContextStore(f.root, 'workspace').directory, full = await physicalBytes(directory)
    await f.service().configure({ maxDiskBytes: full + 128 * 1024 })
    const describe = vi.spyOn(OwnerLedger.prototype, 'describeFunding')
    let producers = 0
    const captured = await f.service().capture({ sessionId: 'creator', callId: 'VISIBLE', label: 'VISIBLE', text: 'ignored', complete: true, source: f.visible.source }, undefined, async () => { producers++; return { text: 'VISIBLE retained text', complete: true } })
    expect(captured?.id).toBe(f.visible.id); expect(producers).toBe(1); expect(describe).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await readFile(resolve(directory, 'owners', f.visible.id + '.json'), 'utf8'))).toEqual(['creator'])
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, await f.observation())).rejects.toThrow()
    expect(await physicalBytes(directory)).toBeLessThanOrEqual(full + 128 * 1024)
    describe.mockRestore()
  } finally { clock.mockRestore(); vi.restoreAllMocks(); await f.close() }
}, 15000)


it('keeps a consumed native close uncertain and retains the original lifetime without a no-op disposal proof', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-consumed-close-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const acquire = locking.acquireSessionLock, close = DatabaseSync.prototype.close, fault = new Error('native close response lost')
  let lifetime: locking.SessionLock | undefined, native: DatabaseSync | undefined, calls = 0
  const acquisition = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
    const lease = await acquire(options)
    if (options.lockPath === locking.lockPathFor(root, 'context-output-legacy:w')) lifetime = lease
    return lease
  })
  try {
    await service.capture(input)
    const path = resolve(new ContextStore(root, 'w').directory, 'index.sqlite')
    const closing = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function(this: DatabaseSync) { native = this; calls++; close.call(this); throw fault })
    await expect(service.clear('s')).rejects.toBe(fault)
    expect(native?.isOpen).toBe(false); expect(lifetime?.held).toBe(true); expect(calls).toBe(1)
    await expect(service.close()).rejects.toBe(fault)
    await expect(service.close()).rejects.toBe(fault)
    expect(calls).toBe(1); expect(lifetime?.held).toBe(true); expect(await stat(path)).toBeDefined()
    await expect(service.capture(input)).rejects.toThrow(/closed/)
    closing.mockRestore()
  } finally {
    // Test-fixture resource disposal follows all assertions; production never
    // treats this manual fixture release as confirmation of its uncertain DB.
    acquisition.mockRestore(); vi.restoreAllMocks(); await lifetime?.release(); await rm(root, { recursive: true, force: true })
  }
})

it('preserves a thrown undefined native commit outcome while cleaning the actual failed capture', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-undefined-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const exec = DatabaseSync.prototype.exec
  try {
    await service.capture(input)
    let cut = false
    const native = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
      if (!cut && sql === 'COMMIT') { cut = true; throw undefined }
      return exec.call(this, sql)
    })
    const outcome = await service.capture({ ...input, callId: 'failed' }).then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error }))
    expect(outcome).toEqual({ kind: 'rejected', error: undefined }); expect(cut).toBe(true)
    native.mockRestore()
    expect(service.status().results).toBe(1)
    expect((await service.search({ sessionId: 's' }, { query: 'needle' })).hits).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})


it('joins prior exact original file debt before clear and keeps an incomplete requested cleanup visible through unrelated queries', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-original-file-debt-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  let original: import('node:fs/promises').FileHandle | undefined, close: (() => Promise<void>) | undefined, attempts = 0, allow = false
  try {
    const ref = await service.capture(input)
    if (!ref) throw Error('fixture refused')
    const directory = new ContextStore(root, 'w').directory, ownerPath = resolve(directory, 'owners', ref.id + '.json'), manifest = resolve(directory, 'artifacts', ref.id + '.json')
    const before = await readFile(manifest), fault = new Error('original canonical file close refused')
    io.opened = (handle, path) => {
      if (original || path !== ownerPath) return
      original = handle; close = handle.close.bind(handle)
      handle.close = async () => { attempts++; if (!allow) throw fault; await close!() }
    }
    await expect(service.read({ sessionId: 's' }, { refId: ref.id })).rejects.toBe(fault)
    expect(attempts).toBe(1); expect(original!.fd).toBeGreaterThanOrEqual(0)
    await expect(service.clear('s')).rejects.toBe(fault)
    expect(attempts).toBe(2); expect(await readFile(manifest)).toEqual(before)
    expect(service.status()).toMatchObject({ state: 'error', results: 1 })
    expect(service.status().error).toContain('original canonical file close refused')
    await expect(service.search({ sessionId: 's' }, { query: 'needle' })).rejects.toBe(fault)
    expect(original!.fd).toBeGreaterThanOrEqual(0)
    expect(service.status().error).toContain('cleanup remains incomplete')
    const incompleteAttempts = attempts
    allow = true; io.opened = undefined
    await service.clear('unrelated')
    expect(attempts).toBe(incompleteAttempts + 1); expect(original!.fd).toBe(-1)
    expect((await service.search({ sessionId: 's' }, { query: 'needle' })).hits).toHaveLength(1)
    expect(attempts).toBe(incompleteAttempts + 1)
    expect(service.status().error).toContain('cleanup remains incomplete')
    await service.clear('s')
    expect(service.status()).toMatchObject({ state: 'ready', results: 0 }); expect(service.status().error).toBeUndefined()
  } finally { allow = true; io.opened = undefined; await service.close(); await close?.(); await rm(root, { recursive: true, force: true }) }
})


it.each(['index-only', 'canonical-before-index', 'committed-unpublished'] as const)('cold recovers actual canonical originals after process exit at the prospective %s boundary', async phase => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-process-cut-'))
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/legacy-index-owner-child.ts', import.meta.url)), root, phase], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  const watchdog = setTimeout(() => child.kill(), 10000)
  const cold = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const code = await new Promise<number | null>((accept, reject) => { child.on('error', reject); child.on('close', accept) })
    expect(code, stderr).toBe(31)
    const receipt = JSON.parse(await readFile(resolve(root, 'child-receipt.json'), 'utf8'))
    const directory = new ContextStore(root, 'w').directory
    if (phase === 'index-only') await expect(stat(resolve(directory, 'artifacts', receipt.prospective.id + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(JSON.parse(await readFile(resolve(directory, 'owners', receipt.prospective.id + '.json'), 'utf8'))).toEqual(['s'])
    const hits = (await cold.search({ sessionId: 's' }, { query: 'needle' })).hits.map(hit => hit.ref.id).sort()
    expect(hits).toEqual((phase === 'index-only' ? [receipt.seed.id] : [receipt.seed.id, receipt.prospective.id]).sort())
    if (phase !== 'index-only') expect((await cold.read({ sessionId: 's' }, { refId: receipt.prospective.id })).text).toBe('prospective needle')
    expect(cold.status().results).toBe(phase === 'index-only' ? 1 : 2)
  } finally { clearTimeout(watchdog); if (child.exitCode === null) child.kill(); await cold.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)


it('preserves the primary prospective failure and exact discard close debt without a second disposal attempt in capture cleanup', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-prospective-close-debt-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const workFault = new Error('prospective original body response lost'), closeFault = new Error('prospective original native close refused')
  const begin = LegacyIndexLifecycle.prototype.beginCaptureReplacement, close = DatabaseSync.prototype.close
  let candidate = '', original: DatabaseSync | undefined, calls = 0
  try {
    const seed = await service.capture(input)
    if (!seed) throw Error('fixture refused')
    const directory = new ContextStore(root, 'w').directory
    await service.configure({ maxDiskBytes: await physicalBytes(directory) + 128 * 1024 })
    const building = vi.spyOn(LegacyIndexLifecycle.prototype, 'beginCaptureReplacement').mockImplementation(async function(this: LegacyIndexLifecycle, ...args) {
      const pending = await begin.apply(this, args); candidate = args[5].ref.id; return pending
    })
    const native = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function(this: DatabaseSync) {
      // The old ready cache retires before the prospective scope is returned.
      if (!candidate) return close.call(this)
      original ??= this; expect(this).toBe(original)
      if (++calls === 1) throw closeFault
      return close.call(this)
    })
    io.afterWrite = async path => { if (candidate && path.endsWith(candidate + '.txt')) throw workFault }
    const failure = await service.capture({ ...input, callId: 'failed-close' }).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toEqual([workFault, closeFault])
    expect(calls).toBe(1); expect(original?.isOpen).toBe(true); expect(service.status().results).toBe(1)
    io.afterWrite = undefined
    await service.close()
    expect(calls).toBe(2); expect(original?.isOpen).toBe(false)
    await expect(stat(resolve(directory, 'index.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    building.mockRestore(); native.mockRestore()
  } finally { io.afterWrite = undefined; vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})


it('cold grants canonical membership within a tiny actual budget without imposing the query index floor', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-cold-grant-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  let cold: ReturnType<typeof createContextOutputService> | undefined
  try {
    await service.capture(input)
    const survivor = await service.capture({ ...input, sessionId: 'other', callId: 'survivor' })
    if (!survivor) throw Error('fixture refused')
    const directory = new ContextStore(root, 'w').directory
    await service.configure({ maxDiskBytes: await physicalBytes(directory) })
    expect((await service.clear('s')).error).toMatch(/index unavailable/i)
    await service.configure({ maxDiskBytes: 32768 }); await service.close()
    cold = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true, maxDiskBytes: 32768 } })
    await cold.grant({ sessionId: 'other' }, [survivor.id], 'recipient')
    expect(JSON.parse(await readFile(resolve(directory, 'owners', survivor.id + '.json'), 'utf8'))).toEqual(['other', 'recipient'])
    expect((await cold.read({ sessionId: 'recipient' }, { refId: survivor.id })).text).toBe(input.text)
    await expect(stat(resolve(directory, 'index.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await physicalBytes(directory)).toBeLessThanOrEqual(32768)
  } finally { await cold?.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})


it('refuses an actual unresolved tracked capture prefix before any admission, replacement or canonical write', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-tracked-prefix-')), gate = createLegacyUseGate(), owner = createWorkspaceMutationOwner({ root, workspaceId: 'w' })
  const store = new ContextStore(root, 'w', owner, gate.assertLease), quota = 1024 * 1024, bytes = Buffer.from(input.text), revision = digest(bytes)
  const ref = { id: referenceId('w', 's', 'c', revision), workspaceId: 'w', sessionId: 's', callId: 'c', label: 'saved', revision, bytes: bytes.length, originalBytes: bytes.length, complete: true, expiresAt: Date.now() + 86400000 }
  try {
    await gate.exclusive(undefined, async lease => {
      await store.acquireLifetime()
      await owner.mutate(async turn => {
        const guard = () => { owner.assertTurn(turn); gate.assertLease(lease, 'exclusive') }
        await store.open(turn, lease, quota, 'query'); await store.ensureIndex(turn, lease, quota)
        await store.put(turn, lease, { ref }, bytes, quota, new AbortController().signal)
        await store.fundLegacyOwner(turn, ref.id, 'target', quota, guard)
        await store.mergeLegacyOwner(turn, lease, ref.id, 'target', 'ordinary:target', guard)
        await store.clear(turn, lease, quota)
        const path = resolve(store.directory, 'owners', ref.id + '.json'), ledger = new OwnerLedger(store.directory, store.retireLegacyFile)
        await ledger.fund(path, new Set(['s']), quota, guard, `capture:${ref.id}`)
        const use = store.indexUse(lease), admission = vi.spyOn(LegacyIndexLifecycle.prototype, 'admitCapture'), replacement = vi.spyOn(LegacyIndexLifecycle.prototype, 'beginCaptureReplacement')
        await expect(store.put(turn, lease, { ref }, bytes, quota, new AbortController().signal)).rejects.toThrow(/unresolved/)
        expect(admission).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled()
        use.assertCurrent(); expect(use.get('SELECT COUNT(*) AS count FROM refs')!.count).toBe(0)
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
        await expect(stat(resolve(store.directory, 'blobs', ref.id + '.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        admission.mockRestore(); replacement.mockRestore()
      })
    })
  } finally { vi.restoreAllMocks(); await gate.exclusive(undefined, lease => store.close(lease)); await owner.close(); await rm(root, { recursive: true, force: true }) }
})


it.each(['clear', 'documents'] as const)('does not describe failed %s cleanup as completed after an earlier capacity-unavailable clear', async operation => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-completion-identity-'))
  let releaseDocuments!: (documents: readonly string[]) => Promise<void>
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, documentDeletions: listener => { releaseDocuments = listener; return () => {} } })
  try {
    const a = await service.capture({ ...input, sessionId: 'A' }), b = await service.capture({ ...input, sessionId: 'B', callId: 'survivor' })
    if (!a || !b) throw Error('fixture refused')
    const directory = new ContextStore(root, 'w').directory
    await service.configure({ maxDiskBytes: await physicalBytes(directory) })
    expect((await service.clear('A')).error).toMatch(/Requested cleanup completed.*index unavailable/i)
    const fault = new Error('B original body unlink refused')
    io.beforeRemove = async path => { if (path === resolve(directory, 'blobs', b.id + '.txt')) throw fault }
    await expect(operation === 'clear' ? service.clear('B') : releaseDocuments(['B'])).rejects.toBe(fault)
    expect(service.status().error).toContain('Requested original cleanup remains incomplete')
    expect(service.status().error).not.toContain('Requested cleanup completed')
    expect(JSON.parse(await readFile(resolve(directory, 'owners', b.id + '.json'), 'utf8'))).toEqual([])
    expect(await stat(resolve(directory, 'blobs', b.id + '.txt'))).toBeDefined()
    expect(await stat(resolve(directory, 'artifacts', b.id + '.json'))).toBeDefined()
    io.beforeRemove = undefined
    await service.clear('B')
    expect(service.status().error).not.toContain('cleanup remains incomplete')
  } finally { io.beforeRemove = undefined; await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['sequential', 'queued'] as const)('retains independent real-ledger A and B cleanup obligations across %s failures and B-only success', async ordering => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-cleanup-scopes-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const a = await service.capture({ ...input, sessionId: 'A' }), b = await service.capture({ ...input, sessionId: 'B', callId: 'B' })
    if (!a || !b) throw Error('fixture refused')
    await service.grant({ sessionId: 'A' }, [a.id], 'shared'); await service.grant({ sessionId: 'B' }, [b.id], 'shared')
    const directory = new ContextStore(root, 'w').directory, aPath = resolve(directory, 'owners', a.id + '.json'), bPath = resolve(directory, 'owners', b.id + '.json')
    const aFault = new Error('A original survivor owner write refused'), bFault = new Error('B original survivor owner write refused')
    const failedOwners: string[] = []
    io.opened = (handle, path) => {
      const owner = path.startsWith(aPath + '.') ? aPath : path.startsWith(bPath + '.') ? bPath : undefined
      if (!owner || !path.endsWith('.tmp')) return
      const write = handle.writeFile.bind(handle)
      handle.writeFile = async (...args) => {
        await write(...args)
        failedOwners.push(owner)
        throw owner === aPath ? aFault : bFault
      }
    }
    if (ordering === 'sequential') {
      await expect(service.clear('A')).rejects.toBe(aFault); await expect(service.clear('B')).rejects.toBe(bFault)
    } else {
      const outcomes = await Promise.allSettled([service.clear('A'), service.clear('B')])
      expect(outcomes).toEqual([{ status: 'rejected', reason: aFault }, { status: 'rejected', reason: bFault }])
    }
    expect(failedOwners).toEqual([aPath, bPath])
    expect(JSON.parse(await readFile(aPath, 'utf8'))).toEqual(['A', 'shared']); expect(JSON.parse(await readFile(bPath, 'utf8'))).toEqual(['B', 'shared'])
    const bothFailures = service.status()
    io.opened = undefined
    await service.clear('B')
    const afterB = service.status()
    expect(JSON.parse(await readFile(aPath, 'utf8'))).toEqual(['A', 'shared']); expect(JSON.parse(await readFile(bPath, 'utf8'))).toEqual(['shared'])
    expect(afterB.state).toBe('error'); expect(afterB.error).toContain(aFault.message); expect(afterB.error).not.toContain(bFault.message)
    expect(bothFailures.error).toContain(aFault.message); expect(bothFailures.error).toContain(bFault.message)
    expect((await service.read({ sessionId: 'shared' }, { refId: a.id })).text).toBe(input.text)
    await service.clear('A')
    expect(JSON.parse(await readFile(aPath, 'utf8'))).toEqual(['shared']); expect(service.status().error).toBeUndefined(); expect(service.status().state).toBe('ready')
  } finally { io.opened = undefined; await service.close(); await rm(root, { recursive: true, force: true }) }
})

// Two native forks and the subsequent quota/repair controls measured 8.6s.
it('keeps an actual A hint refusal visible after quota raise and unrelated B confirmation until A is repaired', async () => {
  const f = await legacyFixture()
  let store: ContextStore | undefined
  const gate = createLegacyUseGate(), owner = createWorkspaceMutationOwner({ root: f.root, workspaceId: 'workspace' })
  try {
    expect((await f.run()).kind).toBe('ready')
    f.request.invocation.operationId = 'binding-B'; f.request.invocation.targetSessionId = 'second-target'
    expect((await f.run()).kind).toBe('ready')
    await f.service().close()
    store = new ContextStore(f.root, 'workspace', owner, gate.assertLease)
    const namespace = resolve(store.directory, 'legacy-fork-v1'), originals = await Promise.all((await readdir(namespace)).map(async name => {
      const directory = resolve(namespace, name), root = JSON.parse(await readFile(resolve(directory, 'plan.json'), 'utf8')) as LegacyRoot
      return { directory, root }
    }))
    const a = originals.find(value => value.root.binding.invocation.operationId !== 'binding-B')!, b = originals.find(value => value.root.binding.invocation.operationId === 'binding-B')!
    const aBinding = recordHash('binding', a.root.binding), bBinding = recordHash('binding', b.root.binding), quota = 8 * 1024 * 1024
    await gate.exclusive(undefined, async lease => {
      await store!.acquireLifetime()
      await owner.mutate(async turn => {
        const current = store!, guard = () => { owner.assertTurn(turn); gate.assertLease(lease, 'exclusive') }
        await current.open(turn, lease, quota, 'query'); await current.ensureIndex(turn, lease, quota)
        const use = current.indexUse(lease)
        await current.resetLegacyIndex(turn, lease, use, aBinding, quota)
        const full = await current.diskBytes()
        await current.configureDiskBudget(turn, lease, full)
        const aPage = JSON.parse(await readFile(resolve(a.directory, 'pages', pageName(a.root.pages!)), 'utf8')) as LegacyPage
        await expect(current.stageLegacyPage(turn, lease, use, aBinding, pageName(a.root.pages!), aPage, full)).rejects.toMatchObject({ code: 'CONTEXT_INDEX_UNAVAILABLE' })
        expect(current.legacyReady(use, a.root)).toBe(false); expect(use.get('SELECT ready FROM legacy_plans WHERE binding=?', [aBinding])!.ready).toBe(0)
        const aIssue = current.indexIssue()
        expect(aIssue?.scope).toBe('legacy-hints')
        await current.configureDiskBudget(turn, lease, quota)
        expect(current.indexIssue()).toEqual(aIssue)
        async function prepare(original: typeof a, binding: string) {
          await current.resetLegacyIndex(turn, lease, use, binding, quota)
          for await (const _ of walkPages(original.directory, original.root, guard, undefined, current.retireLegacyFile, async (ref, page) => {
            await current.stageLegacyPage(turn, lease, use, binding, pageName(ref), page, quota)
          })) { guard() }
          await current.confirmLegacyIndex(turn, lease, use, original.root, quota)
        }
        await prepare(b, bBinding)
        use.assertCurrent(); expect(current.legacyReady(use, b.root)).toBe(true); expect(current.legacyReady(use, a.root)).toBe(false)
        expect(current.indexIssue()).toEqual(aIssue)
        await prepare(a, aBinding)
        use.assertCurrent(); expect(current.legacyReady(use, a.root)).toBe(true); expect(current.indexIssue()).toBeUndefined()
      })
    })
  } finally { if (store) await gate.exclusive(undefined, lease => store!.close(lease)); await owner.close(); await f.close() }
}, 15000)


it.each(['EIO', 'EACCES'] as const)('resets queued clear completion before its actual protected-result inventory rejects with %s', async code => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-queued-inventory-')), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined
  try {
    const a = await service.capture({ ...input, sessionId: 'A' }), b = await service.capture({ ...input, sessionId: 'B', callId: 'survivor' })
    if (!a || !b) throw Error('fixture refused')
    const directory = new ContextStore(root, 'w').directory, managed = resolve(directory, 'managed-v1')
    const paths = [resolve(directory, 'owners', b.id + '.json'), resolve(directory, 'blobs', b.id + '.txt'), resolve(directory, 'artifacts', b.id + '.json')]
    const before = await Promise.all(paths.map(path => readFile(path)))
    await service.configure({ maxDiskBytes: await physicalBytes(directory) })
    const nativeClear = ContextStore.prototype.clear
    let aCompletedUnavailable = false, inventoryCuts = 0
    const clearing = vi.spyOn(ContextStore.prototype, 'clear').mockImplementation(async function(this: ContextStore, ...args) {
      await nativeClear.apply(this, args)
      if (args[3] === 'A') { expect(this.indexIssue()?.scope).toBe('artifact-index'); expect(this.indexReady()).toBe(false); aCompletedUnavailable = true }
    })
    io.beforeRemove = async path => { if (path === resolve(directory, 'blobs', a.id + '.txt')) { entered.resolve(); await resume.promise } }
    first = service.clear('A')
    await entered.promise
    const fault = Object.assign(new Error(`B original protected inventory ${code}`), { code })
    io.beforeReadDirectory = async path => { if (path === managed) { inventoryCuts++; expect(aCompletedUnavailable).toBe(true); throw fault } }
    second = service.clear('B')
    const secondOutcome = second.then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error }))
    resume.resolve(); await first
    expect(await secondOutcome).toEqual({ kind: 'rejected', error: fault })
    expect(inventoryCuts).toBe(1); expect(aCompletedUnavailable).toBe(true); expect(clearing).toHaveBeenCalledTimes(1)
    for (const [index, path] of paths.entries()) expect(await readFile(path)).toEqual(before[index])
    expect(service.status().error).not.toContain('Requested cleanup completed')
    expect(service.status().error).toContain(fault.message); expect(service.status().error).toContain('Requested original cleanup remains incomplete')
    io.beforeRemove = undefined; io.beforeReadDirectory = undefined
    await service.clear('B')
    expect(service.status().error).not.toContain('cleanup remains incomplete')
    clearing.mockRestore()
  } finally { resume.resolve(); io.beforeRemove = undefined; io.beforeReadDirectory = undefined; await Promise.allSettled([first, second]); vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['EIO', 'EACCES'] as const)('records cold document cleanup inventory %s before opening or entering the legacy helper', async code => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-index-document-inventory-'))
  const original = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  let cold: ReturnType<typeof createContextOutputService> | undefined
  try {
    const ref = await original.capture({ ...input, sessionId: 'B' })
    if (!ref) throw Error('fixture refused')
    await original.close()
    const directory = new ContextStore(root, 'w').directory, paths = [resolve(directory, 'owners', ref.id + '.json'), resolve(directory, 'blobs', ref.id + '.txt'), resolve(directory, 'artifacts', ref.id + '.json')]
    const before = await Promise.all(paths.map(path => readFile(path)))
    let releaseDocuments!: (documents: readonly string[]) => Promise<void>
    cold = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, documentDeletions: listener => { releaseDocuments = listener; return () => {} } })
    const fault = Object.assign(new Error(`B original document inventory ${code}`), { code }), clear = vi.spyOn(ContextStore.prototype, 'clear'), open = vi.spyOn(ContextStore.prototype, 'open')
    io.beforeAccess = async path => { if (path === resolve(directory, 'artifacts')) throw fault }
    await expect(releaseDocuments(['B'])).rejects.toBe(fault)
    expect(clear).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
    for (const [index, path] of paths.entries()) expect(await readFile(path)).toEqual(before[index])
    expect(cold.status().state).toBe('error'); expect(cold.status().error).toContain(fault.message); expect(cold.status().error).not.toContain('Requested cleanup completed')
    io.beforeAccess = undefined
    await releaseDocuments(['B'])
    expect(cold.status().error).toBeUndefined()
    clear.mockRestore(); open.mockRestore()
  } finally { io.beforeAccess = undefined; vi.restoreAllMocks(); await cold?.close(); await original.close(); await rm(root, { recursive: true, force: true }) }
})
