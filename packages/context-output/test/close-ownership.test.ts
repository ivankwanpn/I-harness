import { expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createContextOutputService } from '../src/index.ts'
import { ContextStore } from '../src/store.ts'
import { unfinishedResult } from './close-fixture.ts'
import type { BootstrapDependencyRequest } from '@i-harness/core-session'

it.each(['body', 'leaves'] as const)('shares a failed native %s close and explicitly retries the original fenced owner', async target => {
  const root = await mkdtemp(resolve(tmpdir(), 'context-close-'))
  const unsubscribe = vi.fn(), service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, documentDeletions: () => unsubscribe })
  const original = await unfinishedResult(service, root, 'unfinished'), fault = new Error('original native close failed')
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const nativeClose = original[target].close.bind(original[target])
  let failed = false
  const spy = vi.spyOn(original[target], 'close').mockImplementation(async () => {
    if (!failed) { failed = true; entered.resolve(); await resume.promise; throw fault }
    await nativeClose()
  })
  try {
    const first = service.close().then(() => undefined, error => error)
    await entered.promise
    const second = service.close().then(() => undefined, error => error)
    expect(service.status().enabled).toBe(false)
    await expect(service.configure({ enabled: true })).rejects.toThrow(/closed/)
    await expect(service.capture({ sessionId: 's', callId: 'later', label: 'later', text: 'later', complete: true })).rejects.toThrow(/closed/)
    expect(() => service.registerResultScope({ operationId: 'later', sessionId: 's', callId: 'later' }, () => true)).toThrow(/closed/)
    resume.resolve()
    expect(await first).toBe(fault)
    expect(await second).toBe(fault)
    expect(original[target].fd).toBeGreaterThanOrEqual(0)
    await service.close()
    expect(original.body.fd).toBe(-1); expect(original.leaves.fd).toBe(-1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await expect(original.sink.write(Buffer.from('late'))).rejects.toThrow()
    const [workspace] = await readdir(resolve(root, 'context-output'))
    const managed = resolve(root, 'context-output', workspace!, 'managed-v1'), [id] = await readdir(managed)
    const operation = JSON.parse(await readFile(resolve(managed, id!, 'operation.json'), 'utf8'))
    expect(operation).toMatchObject({ phase: 'capturing', encodedBytes: 65536 })
    expect(operation).not.toHaveProperty('ref')
    await service.close()
    expect(spy).toHaveBeenCalledTimes(2)
  } finally { resume.resolve(); spy.mockRestore(); await service.close(); await original.body.close(); await original.leaves.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains a later SQLite close failure without repeating completed artifact cleanup', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'context-store-close-'))
  const unsubscribe = vi.fn(), service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, documentDeletions: () => unsubscribe })
  const original = await unfinishedResult(service, root, 'unfinished')
  await service.capture({ sessionId: 's', callId: 'legacy', label: 'legacy', text: 'legacy', complete: true })
  const bodyClose = vi.spyOn(original.body, 'close'), fault = new Error('SQLite close refused')
  const nativeClose = ContextStore.prototype.close
  let nativeStore: ContextStore | undefined
  let failed = false
  const storeClose = vi.spyOn(ContextStore.prototype, 'close').mockImplementation(async function(this: ContextStore) {
    nativeStore = this
    if (!failed) { failed = true; throw fault }
    await nativeClose.call(this)
  })
  try {
    await expect(service.close()).rejects.toBe(fault)
    expect(original.body.fd).toBe(-1); expect(original.leaves.fd).toBe(-1)
    await service.close()
    expect(storeClose).toHaveBeenCalledTimes(2); expect(bodyClose).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledTimes(1)
    await expect(service.read({ sessionId: 's' }, { refId: 'anything' })).rejects.toThrow(/closed/)
  } finally { storeClose.mockRestore(); bodyClose.mockRestore(); await service.close(); if (nativeStore) { try { await nativeClose.call(nativeStore) } catch {} }; await rm(root, { recursive: true, force: true }) }
})

it.each(['result-scope', 'dependency-scope', 'begin', 'read', 'exec-read', 'transfer-scope', 'transfer-confirm', 'grant'] as const)('fences new %s admission synchronously while a real earlier transition is held', async operation => {
  const root = await mkdtemp(resolve(tmpdir(), 'context-close-fence-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  await service.capture({ sessionId: 's', callId: 'legacy', label: 'legacy', text: 'legacy', complete: true })
  const registered = service.registerResultScope({ operationId: 'unstarted', sessionId: 's', callId: 'unstarted' }, () => true)
  const scope = service.registerResultScope({ operationId: 'committed', sessionId: 's', callId: 'committed' }, () => true)
  const sink = await service.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('original admitted result'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture refused')
  const execScope = service.registerResultScope({ operationId: 'exec', sessionId: 's', callId: 'exec' }, () => true)
  const execSink = await service.beginResult(execScope, 'exec-frames-v1')
  await execSink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'))
  const exec = await execSink.finish('complete'); if (exec.kind !== 'committed') throw Error('fixture refused')
  const request: BootstrapDependencyRequest = { operationId: 'transfer', sourceSessionId: 's', targetSessionId: 't', manifestDigest: 'a'.repeat(64), artifacts: [{ ref: saved.ref, origins: [{ origin: 0, seq: 1, part: 'result' }], uses: [{ kind: 'result' }] }] }
  const access = { binding: { operationId: 'transfer', sourceSessionId: 's', targetSessionId: 't', targetDocumentId: 't', manifestDigest: request.manifestDigest }, sourceAccess: { sessionId: 's' }, sourceAvailable: () => true, assertSourceCurrent() {}, targetAvailable: () => true, targetScope: () => ({ source: { sourceId: 'source' }, revision: 'r' }), assertTargetCurrent() {} }
  const transfer = service.registerSeedDependencyTransfer(access)
  const transferred = operation === 'transfer-confirm' ? await service.confirmSeedDependencies(transfer, request, () => true) : undefined
  if (transferred) expect(transferred.kind).toBe('confirmed')
  let settleOriginal: (() => Promise<string>) | undefined
  if (operation === 'dependency-scope') {
    const entries = [{ kind: 'exec-frames' as const, sourceId: 'native', retention: { kind: 'artifact' as const, ref: exec.ref } }]
    const originalScope = service.registerResultDependencyScope({ operationId: 'original-catalog', sessionId: 's', callId: 'original-catalog' }, () => true, entries)
    const originalSink = await service.beginResult(originalScope, 'json-utf8-v1')
    await originalSink.write(Buffer.from(JSON.stringify({ version: 1, kind: 'result-dependencies', entries })))
    const catalog = await originalSink.finish('complete'); if (catalog.kind !== 'committed') throw Error('fixture refused')
    settleOriginal = () => service.settleResultDependencyMembership(originalScope, catalog.ref)
  }
  // Already admitted original owner operations remain usable; close never
  // invokes these publication/confirmation methods on the caller's behalf.
  expect((await service.readResult({ sessionId: 's' }, { ref: saved.ref })).data).toMatchObject({ text: 'original admitted result' })
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), nativeConfigure = ContextStore.prototype.configureDiskBudget
  const spy = vi.spyOn(ContextStore.prototype, 'configureDiskBudget').mockImplementation(async function(this: ContextStore, ...args) { entered.resolve(); await resume.promise; await nativeConfigure.apply(this, args) })
  const configuring = service.configure({ maxDiskBytes: 100 * 1024 * 1024 })
  await entered.promise
  const closing = service.close()
  try {
    expect(service.status().enabled).toBe(false)
    const owner = { operationId: 'new', sessionId: 's', callId: 'new' }
    if (operation === 'result-scope') expect(() => service.registerResultScope(owner, () => true)).toThrow(/closed/)
    if (operation === 'dependency-scope') expect(() => service.registerResultDependencyScope(owner, () => true, [{ kind: 'exec-frames', sourceId: 'native', retention: { kind: 'artifact', ref: exec.ref } }])).toThrow(/closed/)
    if (operation === 'begin') await expect(service.beginResult(registered, 'text-utf8-v1')).rejects.toThrow(/closed/)
    if (operation === 'read') await expect(service.readResult({ sessionId: 's' }, { ref: saved.ref })).rejects.toThrow(/closed/)
    if (operation === 'exec-read') await expect(service.readExecResult({ sessionId: 's' }, { ref: exec.ref })).rejects.toThrow(/closed/)
    if (operation === 'transfer-scope') expect(() => service.registerSeedDependencyTransfer(access)).toThrow(/closed/)
    if (operation === 'transfer-confirm') expect(await service.confirmSeedDependencies(transfer, request, () => true)).toEqual({ kind: 'blocked', reason: 'unavailable' })
    if (operation === 'grant') await expect(service.grant({ sessionId: 's' }, [saved.ref.id], 'new-reader')).rejects.toThrow(/closed/)
    // Original confirmation and passive reconciliation still use their own
    // owner checks, rather than being mistaken for fresh admission.
    const confirming = service.confirmResultOwner(scope, saved.ref)
    const reconciling = sink.reconcile()
    const settling = settleOriginal?.()
    const transferReconciliation = transferred ? service.reconcileSeedDependencies(transfer, request) : undefined
    // Original operations share the real quota turn held by configure. Release
    // that earlier transition before joining their already admitted work.
    resume.resolve()
    await confirming
    expect(await reconciling).toEqual(saved)
    if (settling) expect(await settling).toBe('ready')
    if (transferReconciliation) expect(await transferReconciliation).toEqual(transferred)
  } finally { resume.resolve(); spy.mockRestore(); await configuring; await closing; await service.close(); await rm(root, { recursive: true, force: true }) }
})
