import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { hydrateSavedDto, hydrateSavedCandidate, savedResultDescriptor } from '../src/saved-result-json.ts'
import { buildSavedProcessIndex } from '../src/saved-process-index.ts'
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
const native = { version: 1 as const, jobId: 'bash-1', instanceId: 'original', ownerSessionId: 'owner', sourceId: 'process:1' }
const ref = (raw: string, c: string, codec = 'json-utf8-v1', completeness = 'complete') => ({ version: 1, id: 'ctxv1_' + c.repeat(64), revision: 'd'.repeat(64), codec, completeness, encodedBytes: Buffer.byteLength(raw), contentDigest: sha(raw) })
function fixture(change: (v: any, catalog: any, args: any) => void = () => {}) {
  const frame = ref('original archive', 'f', 'exec-frames-v1'), args: any = { job_id: 'bash-1', job_instance_id: 'original', source_id: 'process:1', offset_bytes: 0, digest: sha('你好') }
  const value: any = { job_id: 'bash-1', native_job: native, status: 'completed', source: { kind: 'retained-summary' }, scope: 'captured', completeness: 'complete', text: '你好', truncated: false, offset_bytes: 0, next_offset_bytes: 6, total_bytes: 6, stderr_total_bytes: 0, total_raw_bytes: 6, digest: sha('你好'), stderr_digest: sha(''), digest_format: 'sha256-raw-v1', full_result: { tool: 'context_output_read', args: { ref: frame, maxBytes: 32768 }, access: 'catalog-required', catalog_from: 'envelope.dependencies.ref' } }
  const catalog: any = { version: 1, kind: 'result-dependencies', entries: [{ kind: 'exec-frames', sourceId: native.sourceId, retention: { kind: 'artifact', ref: frame } }] }
  change(value, catalog, args)
  const dtoText = JSON.stringify(value), catalogText = JSON.stringify(catalog), dto = ref(dtoText, 'a'), cat = ref(catalogText, 'b')
  const envelope = { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact', ref: dto }, dependencies: { kind: 'artifact-set', count: 1, ref: cat }, preview: 'forged' }
  const calls: any[] = [{ type: 'tool/call', callId: 'a', name: 'shell', args: {} }, { type: 'tool/result', callId: 'a', name: 'shell', envelope: { execution: envelope.execution, retention: { kind: 'inline', value: { job_id: native.jobId, native_job: native } } } }, { type: 'tool/call', callId: 'b', name: 'job_output', args }, { type: 'tool/result', callId: 'b', name: 'job_output', envelope }]
  const selected = buildSavedProcessIndex(calls, 'owner').select('bash-1', 'original')
  const descriptor = savedResultDescriptor(envelope)!
  const binding = selected.kind === 'selected' ? selected.candidate.observation : undefined
  let pages = 0
  const read = async (_id: string, q: any) => { pages++; const raw = q.ref.id === dto.id ? dtoText : catalogText; return { ref: q.ref, offset: q.offset, nextOffset: null, eof: true, data: { kind: 'text', text: raw } } as any }
  const run = (reader = read, bound: any = binding) => (hydrateSavedDto as any)('owner', descriptor, native, reader, () => {}, bound)
  return { run, read, descriptor, binding, value, dtoText, catalogText, candidate: selected.kind === 'selected' ? selected.candidate : undefined, pages: () => pages }
}
it('hydrates exact shipping DTO fields and one original catalog through the index-bound observation', async () => {
  const f = fixture(); expect(await f.run()).toMatchObject({ text: '你好', total_bytes: 6 }); expect(f.pages()).toBe(2)
})
it.each([
  (v: any) => { v.native_job = { ...native, instanceId: 'other' } },
  (v: any) => { v.full_result.args.ref = { ...v.full_result.args.ref, revision: 'e'.repeat(64) } },
  (v: any) => { v.total_raw_bytes = 7 }, (v: any) => { v.digest = 'e'.repeat(64) },
  (v: any) => { v.next_offset_bytes = 5 }, (v: any) => { v.full_result.args.viaCatalog = {} },
  (_v: any, c: any) => { c.entries[0].sourceId = 'foreign' },
  (_v: any, c: any) => { c.entries.push(c.entries[0]) },
  (_v: any, c: any) => { c.extra = true },
  (_v: any, c: any) => { c.entries[0].retention.ref = { ...c.entries[0].retention.ref, completeness: 'source-limited' } },
])('refuses inconsistent shipping metadata and catalog binding %#', async change => { await expect(fixture(change).run()).rejects.toThrow() })
it('requires the original artifact call binding and refuses an arbitrary descriptor', async () => { const f = fixture(); await expect(f.run(f.read, null)).rejects.toThrow() })
it('changed bytes with unchanged valid original ref reach the final digest guard', async () => {
  const f = fixture(); let reads = 0
  await expect(f.run(async (id: string, q: any) => { const p = await f.read(id, q); reads++; return { ...p, data: { kind: 'text', text: p.data.text.replace('你好', '您好') } } })).rejects.toThrow('DTO digest mismatch')
  expect(reads).toBe(1)
})
it.each(['revision', 'offset', 'progress', 'eof', 'surrogate', 'oversize'] as const)('refuses invalid metadata page %s', async kind => {
  const f = fixture()
  await expect(f.run(async (id: string, q: any) => { const p = await f.read(id, q); if (kind === 'revision') p.ref = { ...p.ref, revision: 'e'.repeat(64) }; if (kind === 'offset') p.offset = 1; if (kind === 'progress') { p.eof = false; p.nextOffset = 0; p.data.text = '' }; if (kind === 'eof') p.nextOffset = 1; if (kind === 'surrogate') p.data.text = '\ud800'; if (kind === 'oversize') p.padding = 'x'.repeat(32768); return p })).rejects.toThrow()
})

async function alteredSource(raw: string, options: { chunk?: number; oversized?: boolean; catalog?: boolean } = {}) {
  const f = fixture(), descriptor: any = structuredClone(f.descriptor)
  const chosen = options.catalog ? 'catalog' : 'dto'
  descriptor[chosen] = { ...descriptor[chosen], encodedBytes: Buffer.byteLength(raw), contentDigest: sha(raw) }
  const binding = { ...f.binding!, descriptor }, source = Buffer.from(raw)
  let reads = 0
  const result = (hydrateSavedDto as any)('owner', descriptor, native, async (id: string, q: any) => {
    reads++
    if (q.ref.id !== descriptor[chosen].id) return f.read(id, q)
    let end = Math.min(source.length, q.offset + (options.chunk ?? 4096))
    while (end < source.length && (source[end]! & 0xc0) === 0x80) end--
    return { ref: q.ref, offset: q.offset, nextOffset: end === source.length ? null : end, eof: end === source.length, data: { kind: 'text', text: source.subarray(q.offset, end).toString('utf8') } }
  }, () => {}, binding)
  return { result, reads: () => reads }
}
it('accepts exactly 65536 UTF8 source bytes and rejects 65537 before any reads', async () => {
  const f = fixture(), padded = f.dtoText.slice(0, -1) + ',"padding":"' + 'x'.repeat(65536 - Buffer.byteLength(f.dtoText) - 13) + '"}'
  expect(Buffer.byteLength(padded)).toBe(65536)
  const ok = await alteredSource(padded); expect(await ok.result).toMatchObject({ text: '你好' })
  const bad = await alteredSource(padded + ' '); await expect(bad.result).rejects.toThrow('Invalid JSON descriptor'); expect(bad.reads()).toBe(0)
})
it.each(['duplicate', 'depth', 'nodes', 'surrogate', 'BOM'] as const)('rejects authenticated malformed JSON %s', async mode => {
  const f = fixture()
  const extra = mode === 'depth' ? '"deep":' + '['.repeat(33) + '0' + ']'.repeat(33) : mode === 'nodes' ? '"many":[' + Array(8193).fill('0').join(',') + ']' : mode === 'surrogate' ? '"lossy":"\\ud800"' : '"job_\\u0069d":"bash-1"'
  const raw = mode === 'BOM' ? '\ufeff' + f.dtoText : f.dtoText.slice(0, -1) + ',' + extra + '}'
  const x = await alteredSource(raw); await expect(x.result).rejects.toThrow()
})
it('stops after 128 advancing pages without implicit completion', async () => {
  const x = await alteredSource(fixture().dtoText, { chunk: 1 }); await expect(x.result).rejects.toThrow('page limit'); expect(x.reads()).toBe(128)
})
it('authenticates catalog exact bytes and rejects escaped duplicate authority keys', async () => {
  const x = await alteredSource(fixture().catalogText.replace('"version":1', '"version":1,"vers\\u0069on":1'), { catalog: true })
  await expect(x.result).rejects.toThrow('Duplicate')
})

it('connects the fixed index row, retains outer catalog completeness and rejects a conflicting original frame ref', async () => {
  const f = fixture(), candidate = structuredClone(f.candidate!)
  candidate.descriptor!.catalog = { ...candidate.descriptor!.catalog!, completeness: 'source-limited' }
  candidate.observation!.descriptor = candidate.descriptor
  const result = await hydrateSavedCandidate('owner', candidate, f.read, () => {})
  expect(result.catalogCompleteness).toBe('source-limited'); expect(result.value.completeness).toBe('complete')
  candidate.snapshot = { digest: 'e'.repeat(64) }
  await expect(hydrateSavedCandidate('owner', candidate, f.read, () => {})).rejects.toThrow('Conflicting original native summary')
  candidate.snapshot = { full_result: { args: { ref: { ...f.value.full_result.args.ref, revision: 'e'.repeat(64) } } } }
  await expect(hydrateSavedCandidate('owner', candidate, f.read, () => {})).rejects.toThrow('Conflicting original native frame ref')
})
it('preserves captured source-limited summary and refuses an unavailable dependency without a body request', async () => {
  const limited = fixture((v, _c) => { v.completeness = 'source-limited'; v.truncated = true; v.full_result.args.ref.completeness = 'source-limited' })
  expect(await limited.run()).toMatchObject({ completeness: 'source-limited', truncated: true })
  const unavailable = fixture((_v, c) => { c.entries[0].retention = { kind: 'unavailable', reason: 'quota' } })
  await expect(unavailable.run()).rejects.toThrow('Native source unavailable: quota'); expect(unavailable.pages()).toBe(2)
})
it('refuses invalid or oversized catalog metadata before DTO I/O', async () => {
  const f = fixture(), descriptor = structuredClone(f.descriptor)
  descriptor.catalog!.encodedBytes = 65537
  const binding = { ...f.binding!, descriptor }
  await expect(hydrateSavedDto('owner', descriptor, native, f.read, () => {}, binding)).rejects.toThrow('Invalid catalog descriptor')
  expect(f.pages()).toBe(0)
})
it('invalidated guard after a reader await publishes no parsed DTO', async () => {
  const f = fixture(); let current = true
  await expect(hydrateSavedDto('owner', f.descriptor, native, async (id, q) => { const p = await f.read(id, q); current = false; return p }, () => { if (!current) throw new Error('revoked') }, f.binding!)).rejects.toThrow('revoked')
  expect(f.pages()).toBe(1)
})
it('captures original call arguments before I/O rather than adopting a later digest', async () => {
  const f = fixture(), binding = structuredClone(f.binding!)
  expect(await hydrateSavedDto('owner', f.descriptor, native, async (id, q) => { (binding.args as any).digest = 'e'.repeat(64); return f.read(id, q) }, () => {}, binding)).toMatchObject({ text: '你好' })
})
it('descriptor parsing rejects failed envelopes and malformed or multi-entry metadata', () => {
  const f = fixture()
  for (const modify of [(e: any) => { e.execution.outcome = 'failed' }, (e: any) => { e.retention.ref.extra = true }, (e: any) => { e.dependencies.count = 2 }, (e: any) => { e.dependencies.ref.codec = 'exec-frames-v1' }]) {
    const e: any = { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact', ref: f.descriptor.dto }, dependencies: { kind: 'artifact-set', count: 1, ref: f.descriptor.catalog } }
    const copy = structuredClone(e); modify(copy); expect(savedResultDescriptor(copy)).toBeUndefined()
  }
})

it('rejects contradictory full stdout or known-empty stderr digests even without a call digest', async () => {
  for (const channel of ['stdout', 'stderr']) {
    const f = fixture((v, _c, args) => { delete args.digest; v[channel === 'stdout' ? 'digest' : 'stderr_digest'] = 'e'.repeat(64) })
    await expect(f.run()).rejects.toThrow('Native snapshot digest mismatch')
  }
})

it('catalog cap is inclusive at 65536 and larger catalogs refuse before I/O', async () => {
  const f = fixture(), raw = f.catalogText + ' '.repeat(65536 - Buffer.byteLength(f.catalogText))
  const ok = await alteredSource(raw, { catalog: true }); expect(await ok.result).toMatchObject({ text: '你好' })
  const bad = await alteredSource(raw + ' ', { catalog: true }); await expect(bad.result).rejects.toThrow('Invalid catalog descriptor'); expect(bad.reads()).toBe(0)
})

it('uses original UTF8 byte offsets for contiguous pages split between multibyte scalars', async () => {
  const f = fixture(), boundary = f.dtoText.indexOf('你好') + 1, parts = [f.dtoText.slice(0, boundary), f.dtoText.slice(boundary)]
  const firstBytes = Buffer.byteLength(parts[0]!)
  let count = 0
  expect(await f.run(async (id: string, q: any) => {
    if (q.ref.id !== f.descriptor.dto.id) return f.read(id, q)
    const index = count++; expect(q.offset).toBe(index ? firstBytes : 0)
    return { ref: q.ref, offset: q.offset, eof: index === 1, nextOffset: index ? null : firstBytes, data: { kind: 'text', text: parts[index] } }
  })).toMatchObject({ text: '你好' })
  expect(count).toBe(2)
})
it('changed catalog bytes under its unchanged valid ref fail at final catalog digest', async () => {
  const f = fixture(); let reads = 0
  await expect(f.run(async (id: string, q: any) => {
    reads++; const p = await f.read(id, q)
    return q.ref.id === f.descriptor.catalog!.id ? { ...p, data: { kind: 'text', text: p.data.text.replace('process:1', 'process:2') } } : p
  })).rejects.toThrow('Catalog digest mismatch')
  expect(reads).toBe(2)
})

it('invalid authenticated JSON refuses without echoing source bytes in the parser error', async () => {
  const x = await alteredSource('{"private":"secret"')
  await expect(x.result).rejects.toThrow(/^Invalid JSON syntax$/)
})

const shippingContinuation = () => ({ tool: 'job_output', args: { job_id: 'bash-1', job_instance_id: 'original', source_id: 'process:1', digest: sha('你好'), offset_bytes: 6 } })
it('preserves the actual shipping text_result continuation and the older absent-field compatibility', async () => {
  const current = fixture(v => { v.text_result = shippingContinuation() })
  expect((await current.run()).text_result).toEqual(shippingContinuation())
  const older = await fixture().run(); expect(Object.hasOwn(older, 'text_result')).toBe(false)
})
it.each([
  ['job', (t: any) => { t.args.job_id = 'other' }],
  ['instance', (t: any) => { t.args.job_instance_id = 'other' }],
  ['source', (t: any) => { t.args.source_id = 'other' }],
  ['digest', (t: any) => { t.args.digest = 'e'.repeat(64) }],
  ['offset', (t: any) => { t.args.offset_bytes = 0 }],
  ['tool', (t: any) => { t.tool = 'other' }],
  ['missing source', (t: any) => { delete t.args.source_id }],
  ['extra args', (t: any) => { t.args.viaCatalog = {} }],
  ['extra field', (t: any) => { t.extra = true }],
  ['null args', (t: any) => { t.args = null }],
] as const)('valid DTO and catalog digests still refuse contradictory text_result %s', async (_field, alter) => {
  const f = fixture(v => { v.text_result = shippingContinuation(); alter(v.text_result) })
  await expect(f.run()).rejects.toThrow(/^Native text continuation mismatch$/)
  expect(f.pages()).toBe(2)
})
it('a present null text_result refuses rather than manufacturing continuation fields', async () => {
  const f = fixture(v => { v.text_result = null })
  await expect(f.run()).rejects.toThrow(/^Native text continuation mismatch$/)
})
