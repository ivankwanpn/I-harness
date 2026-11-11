import { expect, it, vi } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
const inventoryIo = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  close: undefined as ((handle: FileHandle, close: () => Promise<void>) => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, access: async (...args: Parameters<typeof fs.access>) => {
    if (inventoryIo.failure) throw inventoryIo.failure
    return fs.access(...args)
  }, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args), close = handle.close.bind(handle)
    handle.close = () => inventoryIo.close ? inventoryIo.close(handle, close) : close()
    return handle
  } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as locking from '@i-harness/fs-lock'
import { createContextOutputService } from '../src/index.ts'
import { ContextStore } from '../src/store.ts'
import { unfinishedResult } from './close-fixture.ts'

const input = { sessionId: 's', callId: 'c', label: 'saved', text: 'original needle', complete: true }

it.each(['EACCES', 'EIO'])('does not turn %s inventory failure into an empty successful clear', async code => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-clear-io-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const fault = Object.assign(new Error('original inventory failure'), { code })
  inventoryIo.failure = fault
  try { await expect(service.clear()).rejects.toBe(fault) }
  finally { inventoryIo.failure = undefined; await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps actual captured bytes and the original quota debt through service cleanup', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-quota-debt-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const acquire = locking.acquireSessionLock, quotaPath = locking.lockPathFor(root, 'context-output:w'), fault = new Error('original capture quota release failed')
  let turns = 0, releases = 0, original: locking.SessionLock | undefined
  const spy = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
    const lease = await acquire(options)
    if (options.lockPath !== quotaPath || ++turns !== 2) return lease
    original = lease
    return { get held() { return lease.held }, async release() { if (++releases === 1) throw fault; await lease.release() } }
  })
  try {
    await expect(service.capture(input)).rejects.toBe(fault)
    expect(turns).toBe(2); expect(releases).toBe(1); expect(original?.held).toBe(true)
    const scope = service.registerResultScope({ operationId: 'blocked', sessionId: 's', callId: 'blocked' }, () => true)
    await expect(service.beginResult(scope, 'text-utf8-v1')).rejects.toThrow(/unresolved/)
    const captured = (await service.search({ sessionId: 's' }, { query: 'needle' })).hits[0]?.ref
    if (!captured) throw Error('committed original bytes lost after release failure')
    expect((await service.read({ sessionId: 's' }, { refId: captured.id })).text).toBe(input.text)
    // The successful read's idle cleanup settles this same original lease.
    expect(releases).toBe(2); expect(original?.held).toBe(false)
    const admitted = await service.beginResult(scope, 'text-utf8-v1')
    await admitted.write(Buffer.from('after original quota acknowledgement'))
    expect((await admitted.finish('complete')).kind).toBe('committed')
    await service.close()
    expect(releases).toBe(2); expect(original?.held).toBe(false)
    const cold = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    try { expect((await cold.read({ sessionId: 's' }, { refId: captured.id })).text).toBe(input.text) }
    finally { await cold.close() }
  } finally { spy.mockRestore(); await original?.release(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('retries an ordinary failed open only after confirmed disposal and corrected quota', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-open-retry-'))
  const original = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const later = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true, maxDiskBytes: 65536 } })
  try {
    const ref = await original.capture({ ...input, text: 'needle '.repeat(2000) })
    if (!ref) throw Error('fixture refused')
    await original.close()
    await expect(later.read({ sessionId: 's' }, { refId: ref.id })).rejects.toThrow(/quota|retained/)
    await later.configure({ maxDiskBytes: 1024 * 1024 })
    expect((await later.read({ sessionId: 's' }, { refId: ref.id })).text).toBe('needle '.repeat(2000))
  } finally { await original.close(); await later.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps currentness checks for original confirmations queued before close', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-queued-current-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  await service.capture(input)
  let current = true
  const scope = service.registerResultScope({ operationId: 'managed', sessionId: 's', callId: 'managed' }, () => current)
  const sink = await service.beginResult(scope, 'text-utf8-v1')
  await sink.write(Buffer.from('original managed bytes'))
  const saved = await sink.finish('complete')
  if (saved.kind !== 'committed') throw Error('fixture refused')
  const configure = ContextStore.prototype.configureDiskBudget, entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const held = vi.spyOn(ContextStore.prototype, 'configureDiskBudget').mockImplementation(async function(this: ContextStore, ...args) { entered.resolve(); await resume.promise; await configure.apply(this, args) })
  const configuring = service.configure({ maxDiskBytes: 100 * 1024 * 1024 })
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = service.close()
    // The original call is issued before releasing the real earlier quota turn.
    const confirming = service.confirmResultOwner(scope, saved.ref)
    const rejected = expect(confirming).rejects.toThrow(/source closed|unavailable/)
    current = false
    resume.resolve()
    await rejected; await configuring; await closing
    expect(await sink.reconcile()).toEqual(saved)
  } finally { resume.resolve(); held.mockRestore(); await Promise.allSettled([configuring, closing]); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains the original failed opening and DB cleanup and refuses replacement before explicit retirement', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-open-cleanup-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const open = ContextStore.prototype.open, close = DatabaseSync.prototype.close
  const workFailure = new Error('original opening failed'), cleanupFailure = new Error('original DB close failed')
  let database: DatabaseSync | undefined, attempts = 0
  const opening = vi.spyOn(ContextStore.prototype, 'open').mockImplementation(async function(this: ContextStore, ...args) {
    await open.apply(this, args)
    await this.ensureIndex(args[0], args[1], args[2])
    throw workFailure
  })
  const closing = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function(this: DatabaseSync) {
    database ??= this; expect(this).toBe(database)
    if (++attempts === 1) throw cleanupFailure
    return close.call(this)
  })
  try {
    const failure = await service.capture(input).catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toEqual([workFailure, cleanupFailure])
    await expect(service.read({ sessionId: 's' }, { refId: 'missing' })).rejects.toBe(failure)
    expect(opening).toHaveBeenCalledTimes(1); expect(attempts).toBe(1); expect(database?.isOpen).toBe(true)
    await service.close()
    expect(attempts).toBe(2); expect(database?.isOpen).toBe(false)
  } finally { opening.mockRestore(); closing.mockRestore(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('joins late lifetime acquisition before close and retires its original lease without opening SQLite', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-acquiring-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const acquire = locking.acquireSessionLock, entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const lifetimePath = locking.lockPathFor(root, 'context-output-legacy:w')
  const spy = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
    const lease = await acquire(options)
    if (options.lockPath === lifetimePath) { entered.resolve(); await resume.promise }
    return lease
  })
  const open = vi.spyOn(ContextStore.prototype, 'open')
  const capture = service.capture(input).catch(error => error)
  try {
    await entered.promise
    let settled = false
    const closing = service.close().then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    resume.resolve()
    expect((await capture).name).toBe('AbortError'); await closing
    expect(open).not.toHaveBeenCalled()
    const second = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
    try { expect(await second.capture(input)).toBeDefined() } finally { await second.close() }
  } finally { resume.resolve(); spy.mockRestore(); open.mockRestore(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('shares lifetime cleanup failure and retries only the original lease (consumed=%s)', async consumed => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-lifetime-debt-'))
  const policyEntered = Promise.withResolvers<void>(), policyResume = Promise.withResolvers<void>()
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, authorize: async () => {
    policyEntered.resolve(); await policyResume.promise; return true
  } })
  const ref = await service.capture(input)
  if (!ref) throw Error('Original capture unavailable')
  const acquire = locking.acquireSessionLock, entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), fault = new Error('original lifetime release failed')
  const lifetimePath = locking.lockPathFor(root, 'context-output-legacy:w')
  let releases = 0, lifetime: locking.SessionLock | undefined
  const spy = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
    const lease = await acquire(options)
    if (options.lockPath !== lifetimePath) return lease
    lifetime = lease
    return { get held() { return lease.held }, async release() {
      releases++
      if (releases === 1) { entered.resolve(); await resume.promise; if (consumed) await lease.release(); throw fault }
      await lease.release()
    } }
  })
  const dbClose = vi.spyOn(DatabaseSync.prototype, 'close')
  const reading = service.read({ sessionId: 'guest' }, { refId: ref.id }).catch(error => error)
  let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined
  try {
    await Promise.race([policyEntered.promise, reading.then(() => { throw Error('Read settled before original policy gate') })])
    first = service.close().catch(error => error)
    policyResume.resolve()
    await Promise.race([entered.promise, first.then(() => { throw Error('Close settled before original lifetime release') })])
    second = service.close().catch(error => error)
    resume.resolve()
    expect((await reading).name).toBe('AbortError')
    expect(await first).toBe(fault); expect(await second).toBe(fault)
    const calls = spy.mock.calls.length
    if (consumed) {
      await expect(service.close()).rejects.toBe(fault)
      expect(releases).toBe(1)
    } else { await service.close(); expect(releases).toBe(2) }
    expect(spy).toHaveBeenCalledTimes(calls)
    expect(dbClose).toHaveBeenCalledTimes(1)
    await expect(service.capture(input)).rejects.toThrow(/closed/)
  } finally {
    policyResume.resolve(); resume.resolve(); await Promise.allSettled([reading, first, second])
    if (!consumed) await service.close()
    spy.mockRestore(); dbClose.mockRestore(); await lifetime?.release()
    await rm(root, { recursive: true, force: true })
  }
})

it('attempts independent original writer cleanup when one writer suspension fails', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'legacy-writers-close-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  const first = await unfinishedResult(service, root, 'first'), second = await unfinishedResult(service, root, 'second')
  const fault = new Error('first original writer failed')
  let attempts = 0
  inventoryIo.close = async (handle, close) => {
    if (handle === first.body) { attempts++; throw fault }
    await close()
  }
  try {
    await expect(service.close()).rejects.toBe(fault)
    expect(second.body.fd).toBe(-1); expect(second.leaves.fd).toBe(-1)
    await expect(service.close()).rejects.toBe(fault)
    expect(first.body.fd).toBeGreaterThanOrEqual(0); expect(first.leaves.fd).toBe(-1)
    expect(attempts).toBe(1)
    inventoryIo.close = undefined
    await first.body.close()
    await expect(service.close()).rejects.toBe(fault)
    expect(attempts).toBe(1)
  } finally {
    inventoryIo.close = undefined
    await first.body.close(); await first.leaves.close(); await second.body.close(); await second.leaves.close()
    await rm(root, { recursive: true, force: true })
  }
})
