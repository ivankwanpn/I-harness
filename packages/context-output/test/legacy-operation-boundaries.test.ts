import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContextOutputOptions, ContextOutputService } from '../src/types.ts'
import { structureEvidence } from './structure-evidence.ts'

const evidence = structureEvidence('.tmp/legacy-structure')
const { createContextOutputService } = await import('../src/index.ts')
const services: ContextOutputService[] = [], roots: string[] = []
async function create(options: Partial<ContextOutputOptions> = {}) {
  await mkdir(evidence, { recursive: true }); const root = await mkdtemp(join(evidence, 'legacy-')); roots.push(root)
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, ...options }); services.push(service)
  return service
}
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const input = () => ({ sessionId: 'a', callId: 'original', label: 'original', text: 'caller text', complete: true, source: { sourceId: 'original-source', path: 'original-path' } })

it.each([true, false])('snapshots caller fields before returning and invokes the held original producer once (complete=%s)', async complete => {
  const service = await create(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), caller = input()
  const producer = vi.fn(async () => { entered.resolve(); await release.promise; return { text: 'producer needle', complete } })
  const capturing = service.capture(caller, undefined, producer)
  try {
    caller.text = 'changed text'; caller.sessionId = 'changed'; caller.callId = 'changed'; caller.source.sourceId = 'changed'; caller.source.path = 'changed'
    await entered.promise; release.resolve()
    const ref = await capturing
    expect(producer).toHaveBeenCalledTimes(1); expect(ref).toMatchObject({ sessionId: 'a', callId: 'original', label: 'original', complete, originalBytes: 15, source: { sourceId: 'original-source', path: 'original-path' } })
    expect((await service.read({ sessionId: 'a' }, { refId: ref!.id })).text).toBe('producer needle')
  } finally { release.resolve(); await Promise.allSettled([capturing]) }
})

it.each(['disabled', 'impossible', 'preaborted', 'queued-close'] as const)('preserves %s producer admission and async validation', async mode => {
  const service = await create({ config: { enabled: mode !== 'disabled', maxDiskBytes: mode === 'impossible' ? 1 : 1024 * 1024 } })
  const producer = vi.fn(async () => ({ text: 'needle', complete: true }))
  let invalid!: Promise<unknown>
  expect(() => { invalid = service.capture({ ...input(), sessionId: '' }) }).not.toThrow()
  await expect(invalid).rejects.toThrow('sessionId')
  const capturing = service.capture(input(), mode === 'preaborted' ? AbortSignal.abort() : undefined, producer)
  if (mode === 'queued-close' || mode === 'preaborted') {
    const rejected = expect(capturing).rejects.toThrow(/abort/i)
    if (mode === 'queued-close') await service.close()
    await rejected
  } else expect(await capturing).toBeUndefined()
  expect(producer).not.toHaveBeenCalled()
})

it('fixes read and search caller fields, query sets and budgets synchronously before admission', async () => {
  const callers: string[] = []
  const service = await create({ config: { enabled: true, maxReadBytes: 4, maxSearchBytes: 900 }, authorize: access => { callers.push(access.sessionId); return access.sessionId === 'fork' } })
  const ref = await service.capture({ ...input(), text: 'needle ' + 'tail '.repeat(300) })
  const access = { sessionId: 'fork' }, readQuery = { refId: ref!.id, offset: 0, maxBytes: 4 }
  const reading = service.read(access, readQuery)
  access.sessionId = 'denied'; readQuery.refId = 'wrong'; readQuery.offset = 99; readQuery.maxBytes = 1
  expect(await reading).toMatchObject({ text: 'need', offset: 0, nextOffset: 4 })
  const searchAccess = { sessionId: 'fork' }, query = { query: 'needle', refIds: [ref!.id], maxBytes: 900, limit: 1 }
  const searching = service.search(searchAccess, query)
  searchAccess.sessionId = 'denied'; query.query = 'missing'; query.refIds[0] = 'wrong'; query.limit = 99; query.maxBytes = 1
  const found = await searching
  expect(found.hits[0]?.ref.id).toBe(ref!.id); expect(found.hits[0]?.text).toContain('needle')
  expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(900)
  expect(callers).toEqual(['fork', 'fork'])
})

it.each(['read', 'search'] as const)('keeps held %s host authorization cancelable and joins it before close', async operation => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<boolean>(); let policySignal: AbortSignal | undefined
  const service = await create({ authorize: async access => { policySignal = access.signal; entered.resolve(); return release.promise } })
  const ref = await service.capture({ ...input(), text: 'needle' })
  const pending = operation === 'read' ? service.read({ sessionId: 'fork' }, { refId: ref!.id }) : service.search({ sessionId: 'fork' }, { query: 'needle' })
  const rejected = expect(pending).rejects.toThrow(/abort/i)
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    let closed = false; closing = service.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false); expect(policySignal?.aborted).toBe(true)
    release.resolve(true); await rejected; await closing
    expect(service.status().activeJobs).toBe(0)
  } finally { release.resolve(true); await Promise.allSettled([pending, closing]) }
})
