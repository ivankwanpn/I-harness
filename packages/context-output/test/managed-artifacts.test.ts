import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createContextOutputService, createContextOutputTools } from '../src/index.ts'

type Admission = { write(bytes: Uint8Array): Promise<void>; finish(completeness: 'complete'): Promise<{ kind: string; ref?: { encodedBytes: number } }> }
type ManagedService = { registerResultScope?(owner: { operationId: string; sessionId: string; callId: string }, current: () => boolean): { operationId: string }; beginResult?(scope: { operationId: string }, codec: 'text-utf8-v1'): Promise<Admission> }


it('searches and reads a managed result through its context reference', async () => {
  const base = resolve(import.meta.dirname, '../../../build/context-output-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'managed-search-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } })
  try {
    const scope = service.registerResultScope({ operationId: 'search', sessionId: 'a', callId: 'call' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('hello zzz world'))
    const result = await sink.finish('complete')
    if (result.kind !== 'committed') throw new Error('Expected committed fixture')
    const search = await service.search({ sessionId: 'a' }, { query: 'zzz' })
    expect(search.hits).toHaveLength(1)
    expect(search.hits[0]).toMatchObject({ ref: { id: result.ref.id }, offset: 6, endOffset: 9 })
    const page = await service.read({ sessionId: 'a' }, { refId: result.ref.id })
    expect(page.text).toBe('hello zzz world')
    expect(page.eof).toBe(true)
    const foreign = await service.search({ sessionId: 'b' }, { query: 'zzz' })
    expect(foreign.hits).toHaveLength(0)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
it('provides mandatory result admission while optional Context Mode is disabled', async () => {
  const base = resolve(import.meta.dirname, '../../../build/context-output-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'managed-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: false } })
  try {
    const managed = service as typeof service & ManagedService
    const scope = managed.registerResultScope?.({ operationId: 'original-operation', sessionId: 'document-a', callId: 'call-a' }, () => true)
    const sink = scope && await managed.beginResult?.(scope, 'text-utf8-v1')
    for (let index = 0; index < 16; index++) await sink?.write(Buffer.alloc(65536, 120))
    const settlement = await sink?.finish('complete')
    expect(settlement).toMatchObject({ kind: 'committed', ref: { encodedBytes: 1_048_576 } })
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('verifies empty bodies through their rooted empty leaf instead of skipping index validation', async () => {
  const base = resolve(import.meta.dirname, '../../../build/context-output-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'empty-'))
  const service = createContextOutputService({ root, workspaceId: 'w' })
  try {
    const scope = service.registerResultScope({ operationId: 'empty', sessionId: 'a', callId: 'c' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1'), result = await sink.finish('complete')
    expect(result.kind).toBe('committed')
    if (result.kind !== 'committed') throw new Error('Expected committed empty fixture')
    // Independent spec-only vector from root-spec-integrity-vectors.json,
    // authored from binary SHA preimages without importing shipping code.
    expect(result.ref.revision).toBe('da32e22048d68e2fb1cecccf1ec47b1c70f8712f4aac7cc37bec804a0ad0e3c5')
    const index = resolve(root, 'context-output', createHash('sha256').update('w').digest('hex'), 'managed-v1', result.ref.id, 'index')
    expect(createHash('sha256').update(await readFile(index)).digest('hex')).toBe('e935f29733b669874a41d44f4c7da0e1ff851a755cf7f188d7169c95533de6bc')
    const file = await open(index, 'r+')
    try { await file.write(Buffer.from([255]), 0, 1, 64); await file.sync() } finally { await file.close() }
    await expect(service.readResult({ sessionId: 'a' }, { ref: result.ref })).rejects.toThrow(/corrupt/)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps the complete1MiB immutable result across disabled-mode clear and a cold open', async () => {
  const base = resolve(import.meta.dirname, '../../../build/context-output-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'cold-'))
  const service = createContextOutputService({ root, workspaceId: 'w' })
  let cold: ReturnType<typeof createContextOutputService> | undefined
  try {
    const scope = service.registerResultScope({ operationId: 'original', sessionId: 'a', callId: 'c' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    const original = Buffer.alloc(65536, 120), expected = createHash('sha256')
    for (let index = 0; index < 16; index++) { expected.update(original); await sink.write(original) }
    const result = await sink.finish('complete')
    if (result.kind !== 'committed') throw new Error('Expected committed fixture')
    expect(result.ref.contentDigest).toBe(expected.digest('hex'))
    const ref = result.ref
    const reordered = { completeness: ref.completeness, contentDigest: ref.contentDigest, encodedBytes: ref.encodedBytes, codec: ref.codec, revision: ref.revision, id: ref.id, version: 1 as const }
    expect((await service.readResult({ sessionId: 'a' }, { ref: reordered })).data.kind).toBe('text')
    expect((await service.clear()).clearDisposition).toBe('protected')
    await service.close()
    cold = createContextOutputService({ root, workspaceId: 'w' })
    const readTool = createContextOutputTools(cold).find(tool => tool.name === 'context_output_read')!
    const toolPage = await readTool.execute({ ref: result.ref }, { sessionId: 'a' })
    expect(toolPage).toMatchObject({ ref: result.ref, data: { kind: 'text', text: expect.stringMatching(/^x+$/) } })
    const digest = createHash('sha256'); let offset = 0
    for (;;) {
      const page = await cold.readResult({ sessionId: 'a' }, { ref: result.ref, offset })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
      if (page.data.kind !== 'text') throw new Error('Expected text page')
      digest.update(page.data.text)
      offset += Buffer.byteLength(page.data.text)
      if (page.eof) break
      expect(page.nextOffset).toBe(offset)
    }
    expect(offset).toBe(1_048_576)
    expect(digest.digest('hex')).toBe(result.ref.contentDigest)
  } finally { await cold?.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('resumes only the original admitted chunk after a partial write and caller-buffer mutation', async () => {
  const base = resolve(import.meta.dirname, '../../../build/context-output-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'write-cut-'))
  const service = createContextOutputService({ root, workspaceId: 'w' })
  const probe = await open(resolve(root, 'probe'), 'w'), prototype = Object.getPrototypeOf(probe)
  const originalWrite = prototype.write
  let cut = false
  try {
    await probe.close()
    const scope = service.registerResultScope({ operationId: 'partial', sessionId: 'a', callId: 'c' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    const spy = vi.spyOn(prototype, 'write').mockImplementation(async function(this: unknown, ...args: unknown[]) {
      const bytes = args[0]
      if (!cut && bytes instanceof Uint8Array && bytes.length === 65536 && args[3] === 0) {
        cut = true
        await Reflect.apply(originalWrite, this, [bytes, 0, 17, 0])
        throw new Error('actual partial body write cut')
      }
      return Reflect.apply(originalWrite, this, args)
    })
    const input = Buffer.alloc(65536, 120), writing = sink.write(input)
    input.fill(121)
    await expect(writing).rejects.toThrow('actual partial body write cut')
    spy.mockRestore()
    const recoverable = sink as typeof sink & { reconcileWrite?(): Promise<'ready' | 'recovery-required'> }
    expect(await recoverable.reconcileWrite?.()).toBe('ready')
    const result = await sink.finish('complete')
    if (result.kind !== 'committed') throw new Error('Expected original capture commit')
    expect(result.ref.encodedBytes).toBe(65536)
    expect(result.ref.contentDigest).toBe(createHash('sha256').update(Buffer.alloc(65536, 120)).digest('hex'))
  } finally { vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('checks current managed-source authorization and never borrows the legacy reference predicate', async () => {
  const base = resolve(import.meta.dirname, '../../../build/context-output-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'managed-acl-'))
  let allowed = true
  const options = { root, workspaceId: 'w', authorize: () => true, authorizeResult: () => allowed }
  const service = createContextOutputService(options)
  try {
    const scope = service.registerResultScope({ operationId: 'source-owned', sessionId: 'a', callId: 'c', source: { sourceId: 'current-project-scope' } }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('actual source-bound output'))
    const result = await sink.finish('complete')
    if (result.kind !== 'committed') throw new Error('Expected source fixture commit')
    expect((await service.readResult({ sessionId: 'a' }, { ref: result.ref })).data).toEqual({ kind: 'text', text: 'actual source-bound output' })
    allowed = false
    await expect(service.readResult({ sessionId: 'a' }, { ref: result.ref })).rejects.toThrow(/unauthorized/)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('recovers original operation initialization after metadata sync uncertainty without making a second scope', async () => {
  const base = resolve(import.meta.dirname, '../../../build/context-output-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'begin-cut-')), service = createContextOutputService({ root, workspaceId: 'w' })
  const probe = await open(resolve(root, 'probe'), 'w'), prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync
  await probe.close()
  let cut = false
  const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: { stat(): Promise<{ size: number }> }) {
    await Reflect.apply(originalSync, this, [])
    if (!cut && (await this.stat()).size > 100) { cut = true; throw new Error('initial operation metadata sync unknown') }
  })
  try {
    const scope = service.registerResultScope({ operationId: 'original-begin', sessionId: 'a', callId: 'c' }, () => true)
    await expect(service.beginResult(scope, 'text-utf8-v1')).rejects.toThrow('initial operation metadata sync unknown')
    spy.mockRestore()
    const sink = await service.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('original'))
    const stored = await sink.finish('complete')
    expect(stored.kind).toBe('committed')
    if (stored.kind !== 'committed') throw new Error('Expected original operation commitment')
    expect(stored.ref.encodedBytes).toBe(8)
    expect((await service.readResult({ sessionId: 'a' }, { ref: stored.ref })).data).toEqual({ kind: 'text', text: 'original' })
  } finally { vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})