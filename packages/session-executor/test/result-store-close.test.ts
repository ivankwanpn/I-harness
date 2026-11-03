import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { acquireAssemblyResultStore, acquireResultReadStore } from '../src/lifecycle/result-store.ts'
import { createSessionService } from '../src/service.ts'
import { ContextStore } from '../../context-output/src/store.ts'
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

it('keeps failed final retirement fenced until the original lease retries its real native handles', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const fault = new Error('native body close refused'), nativeClose = f.original.body.close.bind(f.original.body)
  let failed = false
  const close = vi.spyOn(f.owner, 'close'), bodyClose = vi.spyOn(f.original.body, 'close').mockImplementation(async () => {
    if (!failed) { failed = true; entered.resolve(); await resume.promise; throw fault }
    await nativeClose()
  })
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
    await expect(acquireAssemblyResultStore(f.options)).rejects.toThrow(/retir|cleanup/i)
    expect(close).toHaveBeenCalledTimes(1); expect(f.original.body.fd).toBeGreaterThanOrEqual(0)
    await Promise.all([f.lease.release(), f.lease.release()])
    expect(close).toHaveBeenCalledTimes(2)
    expect(f.original.body.fd).toBe(-1); expect(f.original.leaves.fd).toBe(-1)
    await f.lease.release(); expect(close).toHaveBeenCalledTimes(2)
    const fresh = await acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })
    try { expect(fresh.service).not.toBe(f.owner); expect(await fresh.sourceFor!('s')).toMatchObject({ readonly: true }) }
    finally { await fresh.release() }
  } finally { resume.resolve(); bodyClose.mockRestore(); close.mockRestore(); await f.close() }
})

it('allows waiting admission only after successful original retirement', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  const nativeClose = f.original.body.close.bind(f.original.body)
  const spy = vi.spyOn(f.original.body, 'close').mockImplementation(async () => { entered.resolve(); await resume.promise; await nativeClose() })
  try {
    const retiring = f.lease.release(); await entered.promise
    let admitted = false
    const acquiring = acquireAssemblyResultStore(f.options).then(value => { admitted = true; return value })
    await new Promise(resolve => setImmediate(resolve)); expect(admitted).toBe(false)
    resume.resolve(); await retiring
    const fresh = await acquiring
    try { expect(fresh.service).not.toBe(f.owner); expect(f.original.body.fd).toBe(-1); expect(f.original.leaves.fd).toBe(-1) }
    finally { await fresh.release() }
  } finally { resume.resolve(); spy.mockRestore(); await f.close() }
})

it('retains both real configure and native cleanup failures with an explicit original-owner retry', async () => {
  const f = await fixture(), read = await acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })
  await f.owner.configure({ enabled: true })
  await f.owner.capture({ sessionId: 's', callId: 'seed', label: 'seed', text: 'seed', complete: true })
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), nativeConfigure = ContextStore.prototype.configureDiskBudget
  let configureFault: unknown
  const configuring = vi.spyOn(ContextStore.prototype, 'configureDiskBudget').mockImplementation(async function(this: ContextStore, ...args) {
    entered.resolve(); await resume.promise
    try { return await nativeConfigure.apply(this, args) } catch (cause) { configureFault = cause; throw cause }
  })
  const cleanupFault = new Error('original artifact close refused')
  const close = vi.spyOn(f.original.body, 'close').mockRejectedValueOnce(cleanupFault)
  await f.lease.release()
  await writeFile(f.settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: true, maxDiskBytes: 1 } } }))
  const acquiring = acquireAssemblyResultStore(f.options).then(value => value, error => error)
  try {
    await entered.promise; await read.release(); resume.resolve()
    const failure = await acquiring
    expect(failure).toBeInstanceOf(AggregateError)
    expect(configureFault).toBeInstanceOf(Error)
    expect(failure.errors).toEqual([configureFault, cleanupFault]); expect(failure.cause).toBe(configureFault)
    expect(failure.retryCleanup).toBeTypeOf('function')
    await expect(acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })).rejects.toThrow(/retir|cleanup/i)
    await failure.retryCleanup()
    expect(f.original.body.fd).toBe(-1); expect(f.original.leaves.fd).toBe(-1)
    await writeFile(f.settings, '{}')
    const fresh = await acquireAssemblyResultStore(f.options)
    try { expect(fresh.service).not.toBe(f.owner) } finally { await fresh.release() }
  } finally { resume.resolve(); configuring.mockRestore(); close.mockRestore(); await read.release(); await f.close() }
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

it('retries the retained original lease through actual session service and assembly teardown', async () => {
  const f = await fixture(), requests = vi.fn()
  const service = createSessionService({ ...f.options, modelPolicy: 'required', modelBuilder: async () => controlledModel(async function* () { requests(); yield { type: 'end' } }) })
  const fault = new Error('assembly original native close refused'), nativeClose = f.original.body.close.bind(f.original.body)
  let failed = false
  const spy = vi.spyOn(f.original.body, 'close').mockImplementation(async () => {
    if (!failed) { failed = true; throw fault }
    await nativeClose()
  })
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
    await service.close()
    expect(service.hasAssembly('s')).toBe(false)
    expect(f.original.body.fd).toBe(-1); expect(f.original.leaves.fd).toBe(-1)
    expect(requests).not.toHaveBeenCalled()
  } finally { spy.mockRestore(); await service.close(); await f.close() }
})
