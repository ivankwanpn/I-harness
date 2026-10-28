import { expect, it } from 'vitest'
import { savedResultDescriptor } from '../src/saved-result-json.ts'
const ref = (codec: 'json-utf8-v1' | 'exec-frames-v1', id: string) => ({ version: 1 as const, id: `ctxv1_${(id === 'dto' ? 'b' : 'c').repeat(64)}`, revision: 'd'.repeat(64), codec, encodedBytes: 20, contentDigest: 'a'.repeat(64), completeness: 'complete' as const })
const envelope = () => ({ execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact', ref: ref('json-utf8-v1', 'dto') }, dependencies: { kind: 'artifact-set', count: 1, ref: ref('json-utf8-v1', 'catalog') }, preview: '{"job_id":"forged"}' })
it('captures exact bounded original DTO and catalog descriptors without consulting preview', () => {
  expect(savedResultDescriptor(envelope())).toEqual({ kind: 'artifact', dto: ref('json-utf8-v1', 'dto'), catalog: ref('json-utf8-v1', 'catalog') })
})
it('rejects invalid, oversized, ambiguous or failed descriptor metadata', () => {
  for (const modify of [
    (e: any) => { e.retention.ref.encodedBytes = 65537 },
    (e: any) => { e.dependencies.count = 2 },
    (e: any) => { e.dependencies.ref.codec = 'exec-frames-v1' },
    (e: any) => { e.execution.outcome = 'failed' },
    (e: any) => { e.retention.ref.extra = true },
  ]) { const e = envelope(); modify(e); expect(savedResultDescriptor(e)).toBeUndefined() }
})

it('hydrates contiguous authenticated UTF-8 pages and checks the fixed job identity', async () => {
  const { createHash } = await import('node:crypto')
  const { hydrateSavedDto } = await import('../src/saved-result-json.ts')
  const nativeJob = { version: 1 as const, jobId: 'bash-1', instanceId: 'i', ownerSessionId: 'owner', sourceId: 's' }
  const raw = JSON.stringify({ job_id: 'bash-1', native_job: nativeJob, text: '你好', offset_bytes: 0 })
  const dto = { ...ref('json-utf8-v1', 'dto'), encodedBytes: Buffer.byteLength(raw), contentDigest: createHash('sha256').update(raw).digest('hex') }
  const parts = [raw.slice(0, raw.indexOf('你好') + 1), raw.slice(raw.indexOf('你好') + 1)]
  let checks = 0
  const read = async (_id: string, query: any) => { const i = query.offset === 0 ? 0 : 1; const size = Buffer.byteLength(parts[i]!); return { ref: dto, offset: query.offset, nextOffset: i ? null : size, eof: !!i, data: { kind: 'text' as const, text: parts[i]! } } }
  expect(await hydrateSavedDto('owner', { kind: 'artifact', dto }, nativeJob, read, () => { checks++ })).toMatchObject({ text: '你好' })
  expect(checks).toBe(5)
  await expect(hydrateSavedDto('owner', { kind: 'artifact', dto: { ...dto, contentDigest: 'f'.repeat(64) } }, nativeJob, read, () => {})).rejects.toThrow()
  await expect(hydrateSavedDto('owner', { kind: 'artifact', dto }, { ...nativeJob, instanceId: 'other' }, read, () => {})).rejects.toThrow()
})


it('rejects changed references, bad progress, premature EOF, continuation and duplicate keys', async () => {
  const { createHash } = await import('node:crypto'), { hydrateSavedDto } = await import('../src/saved-result-json.ts')
  const nativeJob = { version: 1 as const, jobId: 'j', instanceId: 'i', ownerSessionId: 'owner', sourceId: 's' }
  const attempt = async (raw: string, alter: (p: any) => void = () => {}) => {
    const dto = { ...ref('json-utf8-v1', 'dto'), encodedBytes: Buffer.byteLength(raw), contentDigest: createHash('sha256').update(raw).digest('hex') }
    const page = { ref: dto, offset: 0, nextOffset: null, eof: true, data: { kind: 'text', text: raw } }; alter(page)
    return hydrateSavedDto('owner', { kind: 'artifact', dto }, nativeJob, async () => page as any, () => {})
  }
  const raw = JSON.stringify({ job_id: 'j', native_job: nativeJob, text: 'x' })
  await expect(attempt(raw, p => { p.ref = { ...p.ref, revision: 'f'.repeat(64) } })).rejects.toThrow()
  await expect(attempt(raw, p => { p.eof = false; p.nextOffset = 0; p.data.text = '' })).rejects.toThrow()
  await expect(attempt(raw, p => { p.data.text = p.data.text.slice(0, -1) })).rejects.toThrow()
  await expect(attempt(JSON.stringify({ job_id: 'j', native_job: nativeJob, offset_bytes: 3 }))).rejects.toThrow()
  await expect(attempt(raw.replace('"job_id":"j"', '"job_id":"j","job_\\u0069d":"j"'))).rejects.toThrow(/Duplicate/)
})
