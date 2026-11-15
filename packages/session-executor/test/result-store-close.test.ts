import { expect, it, vi } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
// A result writer captures each native handle's close method when it is
// created, so a native close fault must be installed at open time through this
// seam; patching the handle afterwards never reaches the captured method.
const nativeIO = vi.hoisted(() => ({ close: undefined as ((handle: FileHandle, close: () => Promise<void>) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args), close = handle.close.bind(handle)
    handle.close = () => nativeIO.close ? nativeIO.close(handle, close) : close()
    return handle
  } }
})
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { acquireAssemblyResultStore, acquireResultReadStore } from '../src/lifecycle/result-store.ts'
import { createSessionService } from '../src/service.ts'
import { unfinishedResult } from '../../context-output/test/close-fixture.ts'
import { controlledModel } from './controlled-model.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'result-close-')), settings = join(root, 'settings.json')
  await writeFile(settings, '{}')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 's' })
  const options = { workspace: root, coordinator, contextOutputSettingsPath: settings, sessionId: 's' }
  const lease = await acquireAssemblyResultStore(options), owner = lease.service!
  const original = await unfinishedResult(owner, root, 'unfinished')
  return { root, settings, coordinator, options, lease, owner, original,
    async close() { await lease.release(); await owner.close(); await original.body.close(); await original.leaves.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}

it('keeps a failed final retirement fenced and reports the retained native close failure', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const fault = new Error('native body close refused')
  let failed = false
  const close = vi.spyOn(f.owner, 'close')
  nativeIO.close = async (handle, closeNative) => {
    if (handle === f.original.body && !failed) { failed = true; entered.resolve(); await resume.promise; throw fault }
    return closeNative()
  }
  try {
    const first = f.lease.release().then(() => undefined, error => error)
    await entered.promise
    const joined = f.lease.release().then(() => undefined, error => error)
    let admitted = false
    const acquiring = acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })
      .then(value => { admitted = true; return value }, error => error)
    await new Promise(resolve => setImmediate(resolve))
    expect(admitted).toBe(false)
    resume.resolve()
    expect(await first).toBe(fault); expect(await joined).toBe(fault)
    expect(await acquiring).toBeInstanceOf(Error)
    await expect(f.lease.sourceFor!('s')).rejects.toThrow(/owner unavailable/)
    expect(close).toHaveBeenCalledTimes(1)
    // A refused final retirement keeps this instance fenced: later admissions
    // and releases report the retained original failure rather than a fresh
    // cleanup attempt, matching the context-output close contract.
    await expect(acquireAssemblyResultStore(f.options)).rejects.toThrow(/retir|cleanup/i)
    await expect(f.lease.release()).rejects.toBe(fault)
    // The caller owns the native handles after a refused retirement; the store
    // never re-attempts a failed native close on its own.
    expect(f.original.body.fd).toBeGreaterThanOrEqual(0)
    nativeIO.close = undefined
    await f.original.body.close(); await f.original.leaves.close()
    expect(f.original.body.fd).toBe(-1); expect(f.original.leaves.fd).toBe(-1)
    await expect(f.lease.release()).rejects.toBe(fault)
  } finally { resume.resolve(); nativeIO.close = undefined; close.mockRestore(); await f.close().catch(() => {}) }
})

it('allows waiting admission only after successful original retirement', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  nativeIO.close = async (handle, closeNative) => { if (handle === f.original.body) { entered.resolve(); await resume.promise } return closeNative() }
  try {
    const retiring = f.lease.release(); await entered.promise
    let admitted = false
    const acquiring = acquireAssemblyResultStore(f.options).then(value => { admitted = true; return value })
    await new Promise(resolve => setImmediate(resolve)); expect(admitted).toBe(false)
    resume.resolve(); await retiring
    const fresh = await acquiring
    try { expect(fresh.service).not.toBe(f.owner); expect(f.original.body.fd).toBe(-1); expect(f.original.leaves.fd).toBe(-1) }
    finally { await fresh.release() }
  } finally { resume.resolve(); nativeIO.close = undefined; await f.close() }
})

it('retains the original native cleanup failure when the last read lease retires the store', async () => {
  const f = await fixture(), read = await acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })
  await f.owner.configure({ enabled: true })
  await f.owner.capture({ sessionId: 's', callId: 'seed', label: 'seed', text: 'seed', complete: true })
  const cleanupFault = new Error('original artifact close refused')
  let failCloseOnRetirement = false
  nativeIO.close = async (handle, closeNative) => { if (handle === f.original.body && failCloseOnRetirement) { failCloseOnRetirement = false; throw cleanupFault } return closeNative() }
  try {
    // The owner lease retires the unfinished writer as soon as the last read
    // lease retires; the injected native close failure must be retained as the
    // original failure and keep the store fenced.
    await f.lease.release()
    failCloseOnRetirement = true
    await expect(read.release()).rejects.toBe(cleanupFault)
    expect(f.original.body.fd).toBeGreaterThanOrEqual(0)
    await expect(acquireAssemblyResultStore(f.options)).rejects.toThrow(/retir|cleanup/i)
    nativeIO.close = undefined
    await f.original.body.close(); await f.original.leaves.close()
    expect(f.original.body.fd).toBe(-1); expect(f.original.leaves.fd).toBe(-1)
    await expect(acquireAssemblyResultStore(f.options)).rejects.toThrow(/retir|cleanup/i)
  } finally { nativeIO.close = undefined; await read.release().catch(() => {}); await f.close().catch(() => {}) }
})

it('keeps a borrowed owner available after repeated lease and service teardown', async () => {
  const f = await fixture(), borrowed = await acquireAssemblyResultStore({ ...f.options, contextOutput: f.owner })
  const read = await acquireResultReadStore({ ...f.options, contextOutput: f.owner, readCallerAvailable: () => true })
  const service = createSessionService({ ...f.options, contextOutput: f.owner })
  try {
    await Promise.all([borrowed.release(), read.release(), service.close()]); await borrowed.release(); await read.release()
    expect(f.original.body.fd).toBeGreaterThanOrEqual(0)
    const scope = f.owner.registerResultScope({ operationId: 'still-active', sessionId: 's', callId: 'c' }, () => true)
    const sink = await f.owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('borrowed owner still active'))
    expect(await sink.finish('complete')).toMatchObject({ kind: 'committed' })
  } finally { await service.close(); await f.close() }
})

it('reports the retained native close failure through actual session service and assembly teardown', async () => {
  const f = await fixture(), requests = vi.fn()
  const service = createSessionService({ ...f.options, modelPolicy: 'required', modelBuilder: async () => controlledModel(async function* () { requests(); yield { type: 'end' } }) })
  const fault = new Error('assembly original native close refused')
  let failed = false
  nativeIO.close = async (handle, closeNative) => {
    if (handle === f.original.body && !failed) { failed = true; throw fault }
    return closeNative()
  }
  try {
    await service.assemblyFor('s')
    await f.lease.release()
    const first = service.close(), joined = service.close()
    expect(joined).toBe(first)
    const failure = await first.catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.errors[0].errors).toContain(fault)
    expect(service.hasAssembly('s')).toBe(true)
    expect(f.original.body.fd).toBeGreaterThanOrEqual(0)
    await expect(acquireAssemblyResultStore(f.options)).rejects.toThrow(/retir|cleanup/i)
    // A refused native close is retained: retrying the close reports the same
    // retained failure instead of re-attempting the handle, so the caller owns
    // the native cleanup and the assembly stays fenced until it succeeds.
    await expect(service.close()).rejects.toBeInstanceOf(AggregateError)
    expect(service.hasAssembly('s')).toBe(true)
    nativeIO.close = undefined
    await f.original.body.close(); await f.original.leaves.close()
    expect(f.original.body.fd).toBe(-1); expect(f.original.leaves.fd).toBe(-1)
    expect(requests).not.toHaveBeenCalled()
  } finally { nativeIO.close = undefined; await service.close().catch(() => {}); await f.close().catch(() => {}) }
})
