import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, readdir, readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '../src/index.ts'

it('releases only confirmed deleted document pins and preserves a separately granted document', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-ownership-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'documents-')), backend = createJsonlBackend(resolve(root, 'sessions'))
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } },taskDocumentStorageContract)
  const a = (await coordinator.create()).id, b = (await coordinator.create()).id
  type DeletionSource = { onDocumentDeleted?(listener: (sessionId: string, manifest: { documents: string[] }) => Promise<void>): () => void }
  const owner = coordinator as typeof coordinator & DeletionSource
  const service = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'w',
    documentDeletions: (listener: (documents: readonly string[]) => Promise<void>) => owner.onDocumentDeleted?.((id, manifest) => listener([id, ...manifest.documents])) ?? (() => {}) })
  try {
    const scope = service.registerResultScope({ operationId: 'original', sessionId: a, callId: 'c' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('complete owned body'))
    const result = await sink.finish('complete')
    if (result.kind !== 'committed') throw new Error('Expected committed fixture')
    await service.grant({ sessionId: a }, [result.ref.id], b)
    expect((await service.readResult({ sessionId: b }, { ref: result.ref })).data).toEqual({ kind: 'text', text: 'complete owned body' })
    await coordinator.updateMeta(a, { archived: true })
    expect((await service.clear()).clearDisposition).toBe('protected')
    await coordinator.deleteOwnedSession!(a, { documents: [] })
    await expect(service.readResult({ sessionId: a }, { ref: result.ref })).rejects.toThrow()
    expect((await service.readResult({ sessionId: b }, { ref: result.ref })).data.kind).toBe('text')
    await coordinator.deleteOwnedSession!(b, { documents: [] })
    await expect(service.readResult({ sessionId: b }, { ref: result.ref })).rejects.toThrow()
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not publish or resurrect a document pin deleted after its body write', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-ownership-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'delete-capturing-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } },taskDocumentStorageContract)
  const a = (await coordinator.create()).id, document = (await coordinator.create()).id
  const service = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'w',
    documentDeletions: listener => coordinator.onDocumentDeleted!((id, manifest) => listener([id, ...manifest.documents])) })
  try {
    const scope = service.registerResultScope({ operationId: 'held-original', sessionId: a, documentId: document, callId: 'c' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('the original body was written once'))
    await coordinator.deleteOwnedSession!(document, { documents: [] })
    const result = await sink.finish('complete')
    expect(result.kind).toBe('refused')
    expect(result).toMatchObject({ reason: 'capture-canceled', observedEncodedBytes: 34 })
    expect(await sink.reconcile()).toEqual(result)
    const managed = resolve(root, 'context', 'context-output', createHash('sha256').update('w').digest('hex'), 'managed-v1')
    const paths = await readdir(managed)
    expect(paths).toHaveLength(1)
    expect(await readdir(resolve(managed, paths[0]!))).not.toContain('pins')
    expect(JSON.parse(await readFile(resolve(managed, paths[0]!, 'operation.json'), 'utf8')).phase).toBe('refused')
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps the original operation unresolved when its owner closes after the body write', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-ownership-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'close-capturing-'))
  const service = createContextOutputService({ root, workspaceId: 'w' })
  try {
    const scope = service.registerResultScope({ operationId: 'closed-original', sessionId: 'a', callId: 'c' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('owned bytes'))
    await service.close()
    expect((await sink.finish('complete')).kind).toBe('recovery-required')
    expect((await sink.reconcile()).kind).toBe('recovery-required')
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not publish an original source that loses its settlement lifetime after writing', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-ownership-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'source-capturing-'))
  const service = createContextOutputService({ root, workspaceId: 'w' })
  let current = true
  try {
    const scope = service.registerResultScope({ operationId: 'source-original', sessionId: 'a', callId: 'c' }, () => current)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('owned bytes'))
    current = false
    expect((await sink.finish('complete')).kind).toBe('recovery-required')
    expect((await sink.reconcile()).kind).toBe('recovery-required')
    current = true
    expect((await sink.reconcile()).kind).toBe('committed')
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('resolves the original uncertain pin write before canceling a confirmed deleted document', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-ownership-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'delete-pin-unknown-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } },taskDocumentStorageContract)
  const a = (await coordinator.create()).id, document = (await coordinator.create()).id
  const service = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'w',
    documentDeletions: listener => coordinator.onDocumentDeleted!((id, manifest) => listener([id, ...manifest.documents])) })
  const probe = await open(resolve(root, 'probe'), 'w'), prototype = Object.getPrototypeOf(probe), originalWrite = prototype.write
  await probe.close()
  let cut = false
  try {
    const scope = service.registerResultScope({ operationId: 'pin-unknown', sessionId: a, documentId: document, callId: 'c' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('original body'))
    const spy = vi.spyOn(prototype, 'write').mockImplementation(async function(this: unknown, ...args: unknown[]) {
      const bytes = args[0]
      const result = await Reflect.apply(originalWrite, this, args)
      if (!cut && bytes instanceof Uint8Array && Buffer.from(bytes).toString().includes(`"documentId":"${document}"`) && Buffer.from(bytes).toString().includes('"state":"pending"')) {
        cut = true; throw new Error('original pin write unknown')
      }
      return result
    })
    expect((await sink.finish('complete')).kind).toBe('recovery-required')
    expect(cut).toBe(true)
    spy.mockRestore()
    await coordinator.deleteOwnedSession!(document, { documents: [] })
    expect(await sink.reconcile()).toMatchObject({ kind: 'refused', reason: 'capture-canceled' })
    const managed = resolve(root, 'context', 'context-output', createHash('sha256').update('w').digest('hex'), 'managed-v1')
    const [id] = await readdir(managed)
    expect(await readdir(resolve(managed, id!, 'pins'))).toEqual([])
    expect(await readdir(resolve(managed, id!, 'access'))).toEqual([])
  } finally { vi.restoreAllMocks(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('does not cache a canceled disposition before its original refusal metadata is resolved', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-ownership-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'refusal-unknown-'))
  let deleted: ((documents: readonly string[]) => Promise<void>) | undefined
  const service = createContextOutputService({ root, workspaceId: 'w', documentDeletions: listener => { deleted = listener; return () => {} } })
  const probe = await open(resolve(root, 'probe'), 'w'), prototype = Object.getPrototypeOf(probe), originalWrite = prototype.write
  await probe.close()
  let cut = false
  try {
    const sink = await service.beginResult(service.registerResultScope({ operationId: 'refusal-unknown', sessionId: 'a', callId: 'c' }, () => true), 'text-utf8-v1')
    await sink.write(Buffer.from('original'))
    await deleted!(['a'])
    const spy = vi.spyOn(prototype, 'write').mockImplementation(async function(this: unknown, ...args: unknown[]) {
      const result = await Reflect.apply(originalWrite, this, args)
      if (!cut && args[0] instanceof Uint8Array && Buffer.from(args[0]).toString().includes('"phase":"refused"')) { cut = true; throw new Error('original refusal record unknown') }
      return result
    })
    const first = await sink.finish('complete').catch(() => ({ kind: 'recovery-required' }))
    expect(first.kind).toBe('recovery-required'); expect(cut).toBe(true)
    spy.mockRestore()
    expect(await sink.reconcile()).toMatchObject({ kind: 'refused', reason: 'capture-canceled' })
    const managed = resolve(root, 'context-output', createHash('sha256').update('w').digest('hex'), 'managed-v1')
    const [id] = await readdir(managed)
    expect(JSON.parse(await readFile(resolve(managed, id!, 'operation.json'), 'utf8')).phase).toBe('refused')
  } finally { vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})
