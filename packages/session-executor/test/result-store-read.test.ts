import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { acquireAssemblyResultStore, acquireResultReadStore } from '../src/lifecycle/result-store.ts'
import { createSessionService } from '../src/service.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'result-lease-')), settings = join(root, 'settings.json')
  await writeFile(settings, '{}')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'parent' }); await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent' })
  const options = { workspace: root, coordinator, contextOutputSettingsPath: settings, sessionId: 'parent' }
  return { root, settings, coordinator, options, async close() { await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}

it('does not let a child reader mask the confirmed ancestor producer scope or scope loss', async () => {
  const f = await fixture()
  let scope: { id: string; roots: string[] } | undefined = { id: 'project', roots: [f.root] }
  const producer = await acquireAssemblyResultStore({ ...f.options, projectContext: () => scope })
  const binding = 'desktop-session-project-' + createHash('sha256').update('parent').digest('hex')
  await f.coordinator.putDocument(binding, { version: 1, projectId: 'project' })
  const read = await acquireResultReadStore({ ...f.options, sessionId: 'child', readCallerAvailable: () => true })
  try {
    const expected = await producer.sourceFor!('child')
    expect(await read.sourceFor!('child')).toEqual(expected)
    scope = undefined
    await expect(read.sourceFor!('child')).rejects.toThrow(/scope unconfirmed/)
  } finally { await read.release(); await producer.release(); await f.close() }
})

it.each([false, true])('reserves a configuring producer before last reader release (configure rejects=%s)', async rejects => {
  const f = await fixture(), read = await acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>(), owner = read.service!
  const close = vi.spyOn(owner, 'close'), native = owner.configure.bind(owner)
  vi.spyOn(owner, 'configure').mockImplementation(async config => { entered.resolve(); await resume.promise; if (rejects) throw new Error('controlled configure refusal'); return native(config) })
  await writeFile(f.settings, JSON.stringify({ contextSubsystems: { contextOutput: { maxPreviewBytes: 12000 } } }))
  const producer = acquireAssemblyResultStore(f.options)
  const settled = producer.then(value => ({ value }), error => ({ error }))
  try {
    await entered.promise; await read.release(); expect(close).not.toHaveBeenCalled()
    resume.resolve(); const result = await settled
    if ('value' in result) { expect(result.value.service).toBe(owner); expect(close).not.toHaveBeenCalled(); await result.value.release() }
    else expect(result.error.message).toBe('controlled configure refusal')
    expect(close).toHaveBeenCalledTimes(1)
    const fresh = await acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })
    expect(fresh.service).not.toBe(owner); await fresh.release()
  } finally { resume.resolve(); await read.release(); await f.close() }
})

it('reads an active producer without configuring, then replaces a retired entry on new admission', async () => {
  const f = await fixture(), producer = await acquireAssemblyResultStore(f.options), owner = producer.service!
  const configure = vi.spyOn(owner, 'configure'), close = vi.spyOn(owner, 'close')
  try {
    const read = await acquireResultReadStore({ ...f.options, readCallerAvailable: () => true })
    expect(read.service).toBe(owner); expect(configure).not.toHaveBeenCalled()
    await producer.release(); expect(close).not.toHaveBeenCalled()
    const next = acquireAssemblyResultStore(f.options); await read.release()
    const newProducer = await next
    expect(close).toHaveBeenCalledTimes(1); expect(newProducer.service).not.toBe(owner)
    await newProducer.release()
  } finally { await producer.release(); await f.close() }
})

it('uses a live confirmed producer without an execution subscription and refuses lost or cold project scope', async () => {
  const f = await fixture(); let scope: { id: string; roots: string[] } | undefined = { id: 'p', roots: [f.root] }
  await f.coordinator.putDocument('desktop-session-project-' + createHash('sha256').update('parent').digest('hex'), { version: 1, projectId: 'p' })
  const producer = await acquireAssemblyResultStore({ ...f.options, projectContext: () => scope }), owner = producer.service!
  const capture = owner.registerResultScope({ operationId: 'live', sessionId: 'parent', callId: 'c', source: await producer.sourceFor!('parent') }, () => true)
  const sink = await owner.beginResult(capture, 'text-utf8-v1'); await sink.write(Buffer.from('live scope body'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Original fixture refused')
  const execution = vi.fn(), service = createSessionService({ ...f.options, projectContextFor: execution, modelBindingFor: execution })
  try {
    expect(await service.readResultPage!('parent', { ref: saved.ref })).toMatchObject({ data: { text: 'live scope body' } })
    scope = undefined; expect(await service.readResultPage!('parent', { ref: saved.ref })).toMatchObject({ kind: 'unavailable' })
    await producer.release(); expect(await service.readResultPage!('parent', { ref: saved.ref })).toMatchObject({ kind: 'unavailable' })
    expect(execution).not.toHaveBeenCalled(); expect(service.hasAssembly('parent')).toBe(false)
  } finally { await service.close(); await producer.release(); await f.close() }
})

it('denies configured read resolver failure even when the supplied original service could read', async () => {
  const f = await fixture(), lease = await acquireAssemblyResultStore(f.options), owner = lease.service!
  const capture = owner.registerResultScope({ operationId: 'resolver-error', sessionId: 'parent', callId: 'c', source: await lease.sourceFor!('parent') }, () => true)
  const sink = await owner.beginResult(capture, 'text-utf8-v1'); await sink.write(Buffer.from('resolver must gate this body'))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw Error('fixture')
  const model = vi.fn(), scope = vi.fn(async () => { throw Error('revoked broker') })
  const service = createSessionService({ ...f.options, contextOutput: owner, resultReadScopeFor: scope, modelBindingFor: model, projectContextFor: model })
  try {
    expect(await service.readResultPage!('parent', { ref: saved.ref })).toMatchObject({ kind: 'unavailable' })
    expect(scope).toHaveBeenCalledWith('parent'); expect(model).not.toHaveBeenCalled(); expect(service.hasAssembly('parent')).toBe(false)
  } finally { await service.close(); await lease.release(); await f.close() }
})
