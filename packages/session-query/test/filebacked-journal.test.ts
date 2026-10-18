import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFactBatch, decodeFactBatch, legacyPrefixDigest, CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { createFileBackedSessionQuery, closeSessionQueries } from '../src/index.ts'
import { parseLinePrefix } from '../src/file-backed/inspection.ts'

it('reads actual format7 replacement history as structural searchable records without writing the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-query-')), path = join(root, 's.jsonl'), journal = metadata()
  const events = [
    { type: 'step/start', seq: 0 }, { type: 'assistant/message', seq: 1, text: 'ORIGINAL_SOURCE' }, { type: 'step/end', seq: 2 },
    { type: 'compaction/replacement', version: 1, seq: 3, replacementId: 'query', text: 'POSITIONAL_SUMMARY',
      coverage: [{ item: { kind: 'exchange', at: { seq: 1, part: 'message' } }, sources: [{ seq: 0, part: 'step' }, { seq: 1, part: 'message' }] }],
      insertBefore: { kind: 'exchange', at: { seq: 1, part: 'message' } } },
  ] as import('@i-harness/core-session').SessionEvent[]
  const frame = encodeFactBatch('query7', journal.legacyPrefixDigest, events)
  const raw = Buffer.concat([Buffer.from(JSON.stringify({ formatVersion: 7, sessionId: 's', createdAt: 'literal', journal }) + '\n'), frame.bytes])
  await writeFile(path, raw)
  const query = createFileBackedSessionQuery({ storeRoot: root })
  try {
    expect(parseLinePrefix(raw).events[3]).toEqual(events[3])
    expect(await query.search('POSITIONAL_SUMMARY')).toEqual([expect.objectContaining({ seq: 3, eventType: 'compaction/replacement' })])
    expect(await query.search('ORIGINAL_SOURCE')).toEqual([expect.objectContaining({ seq: 1, eventType: 'assistant/message' })])
    expect(await readFile(path)).toEqual(raw)
    const wrong = Buffer.from(raw.toString().replace('"formatVersion":7', '"formatVersion":6'))
    expect(() => parseLinePrefix(wrong)).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'format' }))
  } finally { closeSessionQueries() }
})

it.each([1, 2, 3, 4, 5])('refuses replacement records in the actual legacy format%s decoder', formatVersion => {
  const records = [
    { type: 'step/start', seq: 0 }, { type: 'assistant/message', seq: 1, text: 'E' }, { type: 'step/end', seq: 2 },
    { type: 'compaction/replacement', version: 1, seq: 3, replacementId: 'wrong-format', text: 'S', coverage: [{ item: { kind: 'exchange', at: { seq: 1, part: 'message' } }, sources: [{ seq: 0, part: 'step' }, { seq: 1, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 1, part: 'message' } } },
  ]
  const raw = [JSON.stringify({ formatVersion, sessionId: 's' }), ...records.map(record => JSON.stringify(record)), ''].join('\n')
  expect(() => parseLinePrefix(raw)).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'format' }))
})

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const metadata = () => ({ version: 1, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 }) as const
it('reads closed format9 observations and own soft state through the actual file-backed search without writes', async () => {
  const root=await mkdtemp(join(tmpdir(),'ih-r2e-query-')),path=join(root,'s.jsonl'),journal=metadata(),d='a'.repeat(64)
  const facts:import('@i-harness/core-session').SessionEvent[]=[{type:'user/message',seq:0,text:'FORMAT9_RAW_REQUEST'},
    {type:'context/budget',version:2,seq:1,snapshot:{version:2,ownerSessionId:'s',modelId:'fixture',protocol:'custom',bindingFingerprint:d,bindingRevision:0,projectionRevision:0,neutralFingerprint:d,identityCoverage:'partial',
      purpose:'main',estimate:{kind:'unknown',reason:'unconfigured'},disposition:'compatibility',dimensions:[{dimension:'context',state:'unchecked'}],pressure:{kind:'unavailable',reason:'unconfigured'},
      components:{kind:'estimated',source:'projected-heuristic',user:8,assistant:0,tool:0,system:0,schema:0,reasoning:0},output:{capSupport:'unknown',minimumCap:1},recoveryRequired:false,fullByProvider:false,freshness:'current',
      requestContext:{version:1,semanticRevision:d,protectionRevision:d,branchId:d,contextEpoch:d,surfaceRevision:d}}},
    {type:'context/soft-reduction',version:1,op:'start',seq:2,ownerSessionId:'s',sequenceId:'own',workKey:d,sourceKey:d,protectionKey:d,policyKey:d,acceptedExchanges:0,humanTurns:0},
    {type:'context/soft-reduction',version:1,op:'terminal',seq:3,ownerSessionId:'s',sequenceId:'own',startSeq:2,workKey:d,sourceKey:d,outcome:'failed',publication:'none',consumedBeforeKey:d}]
  const frame=encodeFactBatch('query9',journal.legacyPrefixDigest,facts),raw=Buffer.concat([Buffer.from(JSON.stringify({formatVersion:9,sessionId:'s',createdAt:'literal',journal})+'\n'),frame.bytes])
  await writeFile(path,raw);const query=createFileBackedSessionQuery({storeRoot:root})
  try{
    expect(parseLinePrefix(raw).events).toEqual(facts)
    expect(await query.search('FORMAT9_RAW_REQUEST')).toEqual([expect.objectContaining({seq:0,eventType:'user/message'})])
    expect(await readFile(path)).toEqual(raw)
    expect(()=>parseLinePrefix(Buffer.from(raw.toString().replace('"formatVersion":9','"formatVersion":8')))).toThrow()
  }finally{closeSessionQueries()}
})

it('indexes only complete verified format6 groups and fingerprints the exact observed byte prefix without repairing a torn tail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-query-frames-')), path = join(root, 's.jsonl')
  const journal = metadata()
  const first = encodeFactBatch('first', journal.legacyPrefixDigest, [
    { type: 'tool/call', seq: 0, callId: 'c', name: 'probe', args: { z: 1, a: 2 } },
    { type: 'tool/result', seq: 1, callId: 'c', name: 'probe', output: 'FIRST_COMPLETE 中文😀' },
  ])
  const second = encodeFactBatch('second', decodeFactBatch(first.bytes).prefixDigest, [
    { type: 'turn/start', seq: 2 }, { type: 'user/message', seq: 3, text: 'SECOND_GROUP' }, { type: 'turn/end', seq: 4 },
  ])
  const header = Buffer.from(JSON.stringify({ formatVersion: 6, sessionId: 's', createdAt: '2026-10-17T00:00:00Z', journal }) + '\n')
  const prefix = Buffer.concat([header, first.bytes]), torn = Buffer.concat([prefix, second.bytes.subarray(0, second.bytes.length - 2)])
  await writeFile(path, torn)
  const query = createFileBackedSessionQuery({ storeRoot: root })
  try {
    const decoded = parseLinePrefix(torn)
    expect(decoded.events.map(event => event.seq)).toEqual([0, 1])
    expect(Buffer.from(decoded.contentBytes!)).toEqual(prefix)
    expect(hash(decoded.contentBytes!)).toBe(hash(prefix))
    expect(await query.search('FIRST_COMPLETE')).toEqual([expect.objectContaining({ sessionId: 's', seq: 1, eventType: 'tool/result' })])
    expect(await query.search('SECOND_GROUP')).toEqual([])
    expect(await readFile(path)).toEqual(torn)
    const complete = Buffer.concat([prefix, second.bytes])
    await writeFile(path, complete)
    expect(await query.search('SECOND_GROUP')).toEqual([expect.objectContaining({ seq: 3, eventType: 'user/message' })])
    expect(parseLinePrefix(complete).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
    expect(hash(parseLinePrefix(complete).contentBytes!)).toBe(hash(complete))
    expect(await readFile(path)).toEqual(complete)
  } finally { closeSessionQueries() }
})

it('keeps exact inherited non-ASCII CRLF bytes in the structural format6 fingerprint', async () => {
  const legacy = Buffer.from(' { "type":"user/message", "seq":0, "text":"旧記録 中文😀" }\r\n')
  const journal = { ...metadata(), legacyBodyBytes: legacy.length, legacyEventCount: 1, legacyPrefixDigest: legacyPrefixDigest(1, legacy) }
  const frame = encodeFactBatch('after-legacy', journal.legacyPrefixDigest, [{ type: 'assistant/message', seq: 1, text: 'actual framed answer' }])
  const bytes = Buffer.concat([Buffer.from(JSON.stringify({ formatVersion: 6, sessionId: 's', journal }) + '\n'), legacy, frame.bytes])
  const decoded = parseLinePrefix(bytes)
  expect(decoded.events).toEqual([{ type: 'user/message', seq: 0, text: '旧記録 中文😀' }, { type: 'assistant/message', seq: 1, text: 'actual framed answer' }])
  expect(Buffer.from(decoded.contentBytes!)).toEqual(bytes)
  expect(hash(decoded.contentBytes!)).toBe(hash(bytes))
})

it.each(['metadata', 'prefix', 'future'] as const)('refuses changed %s evidence rather than serving stale indexed rows or repairing source bytes', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-query-refusal-')), path = join(root, 's.jsonl')
  const journal = metadata()
  const frame = encodeFactBatch('original', journal.legacyPrefixDigest, [{ type: 'user/message', seq: 0, text: 'ORIGINAL_MARKER' }])
  const header = { formatVersion: 6, sessionId: 's', journal }
  const original = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), frame.bytes])
  await writeFile(path, original)
  const query = createFileBackedSessionQuery({ storeRoot: root })
  try {
    expect(await query.search('ORIGINAL_MARKER')).toHaveLength(1)
    const prior = await stat(path)
    const changed = mode === 'metadata'
      ? Buffer.concat([Buffer.from(JSON.stringify({ ...header, journal: { ...journal, legacyPrefixDigest: '0'.repeat(64) } }) + '\n'), frame.bytes])
      : mode === 'future' ? Buffer.concat([Buffer.from(JSON.stringify({ ...header, formatVersion: CURRENT_FORMAT_VERSION + 1 }) + '\n'), frame.bytes])
        : Buffer.from(original.toString('utf8').replace('ORIGINAL_MARKER', 'CORRUPT__MARKER'))
    await writeFile(path, changed)
    // Exercise a changed observed revision explicitly; NTFS can report the
    // same coarse timestamp for two same-size fixture writes in one tick.
    await utimes(path, prior.atime, new Date(prior.mtimeMs + 1000))
    expect(() => parseLinePrefix(changed)).toThrow()
    await expect(query.search('ORIGINAL_MARKER')).rejects.toMatchObject({ code: 'SESSION_QUERY_OBSERVE_FAILED' })
    await expect(query.search('ORIGINAL_MARKER')).rejects.toMatchObject({ code: 'SESSION_QUERY_OBSERVE_FAILED' })
    expect(await readFile(path)).toEqual(changed)
  } finally { closeSessionQueries() }
})


it.each([false, true])('reads format8 operational frames with exact own header and refuses foreign owner=%s without changing bytes', async foreign => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f4-query-')), path = join(root, 's.jsonl'), journal = metadata()
  const facts = [
    { type: 'user/message', seq: 0, text: 'FORMAT8_RAW_REQUEST', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } },
    { type: 'context/action', version: 1, seq: 1, op: 'open', ownerSessionId: foreign ? 'foreign' : 's', actionId: 'original', purpose: 'main', origin: { kind: 'input', seq: 0 }, startedAt: 100, expiresAt: 200, trustedAt: 100 },
    { type: 'context/action', version: 1, seq: 2, op: 'close', ownerSessionId: foreign ? 'foreign' : 's', actionId: 'original', disposition: 'failed', trustedAt: 101 },
  ] as import('@i-harness/core-session').SessionEvent[]
  const frame = encodeFactBatch('query8', journal.legacyPrefixDigest, facts)
  const raw = Buffer.concat([Buffer.from(JSON.stringify({ formatVersion: 8, sessionId: 's', createdAt: 'literal', journal }) + '\n'), frame.bytes])
  await writeFile(path, raw)
  const query = createFileBackedSessionQuery({ storeRoot: root })
  try {
    if (foreign) {
      expect(() => parseLinePrefix(raw)).toThrow()
      await expect(query.search('FORMAT8_RAW_REQUEST')).rejects.toMatchObject({ code: 'SESSION_QUERY_OBSERVE_FAILED' })
    } else {
      expect(parseLinePrefix(raw).events).toEqual(facts)
      expect(await query.search('FORMAT8_RAW_REQUEST')).toEqual([expect.objectContaining({ seq: 0, eventType: 'user/message' })])
    }
    expect(await readFile(path)).toEqual(raw)
  } finally { closeSessionQueries() }
})
