import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, readdir, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFactBatch, decodeFactBatch, legacyPrefixDigest, CURRENT_FORMAT_VERSION, exportConversationSeed, readFactJournal } from '@i-harness/core-session'
import { createFileBackedSessionQuery, closeSessionQueries } from '../src/index.ts'
import { parseLinePrefix, revisionOf } from '../src/file-backed/inspection.ts'
import { compileSemanticSeed, type BootstrapRequest } from '@i-harness/session-persistence'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'

it('searches an actual current coordinator append as logical facts without changing source bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-query-current-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'current' })
    await coordinator.append('current', [{ type: 'user/message', text: 'CURRENT_COORDINATOR_MARKER' }])
    const { session: snapshot } = await coordinator.load('current')
    expect(snapshot.events).toEqual([expect.objectContaining({ type: 'user/message', seq: 0, text: 'CURRENT_COORDINATOR_MARKER' })])
    const path = join(root, 'current.jsonl'), before = await readFile(path)
    expect(JSON.parse(before.subarray(0, before.indexOf(10)).toString()).formatVersion).toBe(13)
    const query = createFileBackedSessionQuery({ storeRoot: root })
    expect(await query.search('CURRENT_COORDINATOR_MARKER')).toEqual([expect.objectContaining({ sessionId: 'current', seq: 0, eventType: 'user/message' })])
    expect(parseLinePrefix(before).events).toEqual(snapshot.events)
    expect(Buffer.from(parseLinePrefix(before).contentBytes!)).toEqual(before)
    expect(await readFile(path)).toEqual(before)
  } finally { closeSessionQueries(); await coordinator.close() }
})

it.each([11, 12, 13])('decodes literal supported format%s frames as searchable logical facts', async formatVersion => {
  const root = await mkdtemp(join(tmpdir(), 'ih-query-supported-')), path = join(root, 's.jsonl'), journal = metadata()
  const facts = [{ type: 'user/message' as const, seq: 0, text: 'SUPPORTED_FORMAT_MARKER' }]
  const frame = encodeFactBatch('supported', journal.legacyPrefixDigest, facts)
  const raw = Buffer.concat([Buffer.from(JSON.stringify({ formatVersion, sessionId: 's', journal }) + '\n'), frame.bytes])
  await writeFile(path, raw)
  try {
    expect(parseLinePrefix(raw).events).toEqual(facts)
    expect(Buffer.from(parseLinePrefix(raw).contentBytes!)).toEqual(raw)
    expect(await createFileBackedSessionQuery({ storeRoot: root }).search('SUPPORTED_FORMAT_MARKER')).toEqual([expect.objectContaining({ seq: 0, eventType: 'user/message' })])
    expect(await readFile(path)).toEqual(raw)
  } finally { closeSessionQueries() }
})

async function semanticFixture(version: 1 | 2) {
  const root = await mkdtemp(join(tmpdir(), 'ih-query-semantic-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'source' })
  const image = { mediaType: 'image/png' as const, dataBase64: Buffer.from('MEDIA_TRANSPORT_SECRET').toString('base64'), name: 'VISIBLE_IMAGE_MARKER', width: 2, height: 3 }
  await coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'INHERITED_CONVERSATION_MARKER', images: [image] },
    { type: 'step/start' },
    { type: 'tool/call', callId: 'inherited-call', name: 'INHERITED_TOOL_NAME', args: { path: 'INHERITED_ARGUMENT_MARKER', image: { url: 'https://MEDIA_URL_SECRET.invalid', dataBase64: image.dataBase64 }, audioUrl: 'AUDIO_TRANSPORT_SECRET' } },
    { type: 'assistant/message', text: 'INHERITED_ASSISTANT_MARKER', thinkingBlocks: [{ type: 'thinking', thinking: 'PRIVATE_THINKING_MARKER', signature: 'PRIVATE_SIGNATURE_MARKER' }], providerContinuation: { kind: 'openai-compatible', reasoningContent: 'PRIVATE_NATIVE_MARKER' } },
    { type: 'tool/result', callId: 'inherited-call', name: 'INHERITED_TOOL_NAME', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: 'INHERITED_RESULT_MARKER', media: [], retention: { kind: 'unavailable', reason: 'quota' } } },
    { type: 'step/end' },
    { type: 'code/store', version: 1, cellId: 'cell', sessionId: 'source', writes: [['privateStore', 'PASSIVE_STORE_ONLY_MARKER']] },
    { type: 'code/cell', cellId: 'cell', sessionId: 'source', state: 'completed' }, { type: 'turn/end' }])
  const document = await coordinator.openManagedDocument('source'), session = document.view, events = session.events, count = events.length
  const owner = { kind: 'held-public-fork' as const, sourceSessionId: 'source', view: session, factOwner: document, assertCurrent() {
    document.assertReady()
    if (document.view !== session || session.events !== events || events.length !== count) throw new Error('Source changed')
  } }
  const exported = version === 1
    ? exportConversationSeed(session, { kind: 'session', sessionId: 'source' }, { kind: 'completed' })
    : exportConversationSeed(session, { kind: 'session', sessionId: 'source' }, { kind: 'completed' }, { kind: 'public-completed-passive', owner })
  if (exported.kind !== 'seed') throw new Error('Actual source seed export refused')
  expect(exported.seed.version).toBe(version)
  const request: BootstrapRequest = {
    invocation: { version: 1 as const, operationId: 'query-bootstrap', targetSessionId: 'target', createdAt: '2026-10-27T00:00:00.000Z', requestDigest: 'a'.repeat(64) },
    target: { kind: 'new' as const }, metadata: { title: 'query semantic target' }, lineage: { origin: 'fork', parentSession: 'source' }, seed: compileSemanticSeed(exported),
  }
  const never = async (): Promise<never> => { throw new Error('No artifact dependencies in this actual seed') }
  const result = await coordinator.bootstrapSemanticTarget(request, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } })
  expect(result.kind).toBe('ready')
  const snapshot = (await coordinator.load('target')).session
  const files = new Map<string, Buffer>()
  for (const name of await readdir(root)) if (name.endsWith('.jsonl') || name.endsWith('.stage')) files.set(name, await readFile(join(root, name)))
  return { root, coordinator, snapshot, files, raw: files.get('target.jsonl')! }
}

it.each([1, 2] as const)('preserves actual V%s B2 header scope, logical facts and all source/stage bytes', async version => {
  const f = await semanticFixture(version)
  try {
    const header = JSON.parse(f.raw.subarray(0, f.raw.indexOf(10)).toString()), decoded = parseLinePrefix(f.raw)
    expect(header.semanticSeed.version).toBe(version)
    expect(header.seedLength).toBeGreaterThan(0)
    expect(decoded.header).toMatchObject({ semanticSeed: header.semanticSeed, parentSession: 'source', seedLength: header.seedLength, origin: 'fork', createdAt: '2026-10-27T00:00:00.000Z' })
    expect(decoded.events).toEqual(f.snapshot.events)
    expect(decoded.events.at(-1)).toMatchObject({ type: 'session/bootstrap' })
    expect(Buffer.from(decoded.contentBytes!)).toEqual(f.raw)
    const body = f.raw.subarray(f.raw.indexOf(10) + 1), seedEnd = body.indexOf(10) + 1
    for (const incomplete of [f.raw.subarray(0, f.raw.indexOf(10) + 1), f.raw.subarray(0, f.raw.indexOf(10) + 1 + seedEnd)]) {
      expect(() => parseLinePrefix(incomplete)).toThrowError(expect.objectContaining({ code: 'SESSION_BOOTSTRAP_INCOMPLETE' }))
    }
    const wrongScope = Buffer.concat([Buffer.from(JSON.stringify({ ...header, seedLength: header.seedLength + 1 }) + '\n'), body])
    expect(() => parseLinePrefix(wrongScope)).toThrow()
    const query = createFileBackedSessionQuery({ storeRoot: f.root })
    await query.search('unmatched')
    expect(await query.lineage('target', { direction: 'ancestors' })).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'source' })]))
    for (const [name, bytes] of f.files) expect(await readFile(join(f.root, name))).toEqual(bytes)
  } finally { closeSessionQueries(); await f.coordinator.close() }
})

it('rebuilds a literal version2 persistent cache for canonical-valid inherited-prefix semantic facts with unchanged source revision', async () => {
  const f = await semanticFixture(1)
  await f.coordinator.close()
  const path = join(f.root, 'target.jsonl'), dbPath = join(f.root, 'literal-v2.db')
  const originalHeader = JSON.parse(f.raw.subarray(0, f.raw.indexOf(10)).toString())
  const body = Buffer.from(f.snapshot.events.map(event => JSON.stringify(event) + '\n').join(''))
  const header = { ...originalHeader, journal: { version: 1, legacyBodyBytes: body.length, legacyEventCount: f.snapshot.events.length, legacyPrefixDigest: legacyPrefixDigest(f.snapshot.events.length, body), separatorBytes: 0 } }
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), body])
  expect(readFactJournal(body, header.journal, 13, header).events).toEqual(f.snapshot.events)
  expect(parseLinePrefix(bytes).events).toEqual(f.snapshot.events)
  await writeFile(path, bytes)
  f.files.set('target.jsonl', bytes)
  const before = await stat(path), revision = revisionOf(before), oldFingerprint = hash(bytes.subarray(0, bytes.length - 1))

  // Literal old-index fixture, not an old application run. Schema/projection
  // facts verified at BASE1af3c7ab: version2 uses these tables and empty seed
  // text; its format13 raw-prefix fingerprint joins lines without final LF.
  const old = new DatabaseSync(dbPath)
  try {
    old.exec(`PRAGMA application_id=0x49485155; PRAGMA user_version=2;
      CREATE TABLE indexed_sessions(id TEXT PRIMARY KEY,revision TEXT NOT NULL,fingerprint TEXT NOT NULL) STRICT;
      CREATE VIRTUAL TABLE indexed_docs USING fts5(session_id UNINDEXED,seq UNINDEXED,event_type UNINDEXED,time UNINDEXED,text,tokenize='unicode61');
      CREATE TABLE lineage(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,cwd TEXT,parent_session TEXT,seed_length INTEGER,delegation_depth INTEGER,origin TEXT) STRICT;`)
    old.prepare('INSERT INTO indexed_sessions VALUES (?,?,?)').run('target', revision, oldFingerprint)
    for (const event of f.snapshot.events) old.prepare('INSERT INTO indexed_docs VALUES (?,?,?,?,?)').run('target', event.seq!, event.type, 0, '')
    old.prepare('INSERT INTO lineage VALUES (?,?,?,?,?,?,?)').run('target', Date.parse(header.createdAt), null, 'source', header.seedLength, null, 'fork')
    expect(old.prepare("SELECT COUNT(*) AS count FROM indexed_docs WHERE indexed_docs MATCH 'INHERITED_CONVERSATION_MARKER'").get()).toEqual({ count: 0 })
    expect(old.prepare('SELECT revision,fingerprint FROM indexed_sessions WHERE id=?').get('target')).toEqual({ revision, fingerprint: oldFingerprint })
  } finally { old.close() }

  try {
    const outcomes: string[] = []
    const query = createFileBackedSessionQuery({ storeRoot: f.root, dbPath, onInspect: (id, outcome) => { if (id === 'target') outcomes.push(outcome) } })
    expect(await query.search('INHERITED_CONVERSATION_MARKER', { sessionId: 'target' })).toEqual([expect.objectContaining({ sessionId: 'target', seq: 1, eventType: 'conversation/seed-group' })])
    expect(outcomes).toEqual(['indexed'])
    outcomes.length = 0
    expect(await query.search('INHERITED_CONVERSATION_MARKER', { sessionId: 'target' })).toHaveLength(1)
    expect(outcomes).toEqual(['skip'])
    closeSessionQueries()
    const check = new DatabaseSync(dbPath, { readOnly: true })
    try {
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 })
      expect(check.prepare('SELECT revision,fingerprint FROM indexed_sessions WHERE id=?').get('target')).toEqual({ revision, fingerprint: hash(bytes) })
    } finally { check.close() }
    for (const [name, content] of f.files) expect(await readFile(join(f.root, name))).toEqual(content)
    expect(await stat(path)).toMatchObject({ size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, ino: before.ino })
  } finally { closeSessionQueries() }
})

it.each([1, 2] as const)('searches actual V%s inherited conversation seed text in its target', async version => {
  const f = await semanticFixture(version)
  try {
    const query = createFileBackedSessionQuery({ storeRoot: f.root })
    expect(await query.search('INHERITED_CONVERSATION_MARKER', { sessionId: 'target' })).toEqual([
      expect.objectContaining({ sessionId: 'target', seq: 1, eventType: 'conversation/seed-group', snippet: expect.stringContaining('INHERITED_CONVERSATION_MARKER') }),
    ])
    for (const [marker, seq] of [['INHERITED_ASSISTANT_MARKER', 2], ['INHERITED_TOOL_NAME', 2], ['INHERITED_ARGUMENT_MARKER', 2], ['INHERITED_RESULT_MARKER', 2], ['VISIBLE_IMAGE_MARKER', 1]] as const) {
      expect(await query.search(marker, { sessionId: 'target' })).toEqual([expect.objectContaining({ sessionId: 'target', seq, eventType: 'conversation/seed-group', snippet: expect.stringContaining(marker) })])
    }
    for (const hidden of ['PASSIVE_STORE_ONLY_MARKER', 'PRIVATE_THINKING_MARKER', 'PRIVATE_SIGNATURE_MARKER', 'PRIVATE_NATIVE_MARKER', 'MEDIA_URL_SECRET', 'AUDIO_TRANSPORT_SECRET', Buffer.from('MEDIA_TRANSPORT_SECRET').toString('base64'), 'TUVESUFf']) {
      expect(await query.search(hidden, { sessionId: 'target' })).toEqual([])
    }
    for (const [name, bytes] of f.files) expect(await readFile(join(f.root, name))).toEqual(bytes)
  } finally { closeSessionQueries(); await f.coordinator.close() }
})

it.each(['metadata', 'missing-journal', 'semantic-header', 'protocol', 'frame', 'delivery', 'future'] as const)('refuses current %s corruption instead of serving indexed rows or changing bytes', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-query-current-refusal-')), path = join(root, 's.jsonl'), journal = metadata()
  const frame = encodeFactBatch('current-refusal', journal.legacyPrefixDigest, [{ type: 'user/message', seq: 0, text: 'CURRENT_ORIGINAL_MARKER' }])
  const header = { formatVersion: 13, sessionId: 's', origin: 'subagent', subagentProtocolVersion: 1, journal }
  const original = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), frame.bytes])
  await writeFile(path, original)
  try {
    const query = createFileBackedSessionQuery({ storeRoot: root })
    expect(parseLinePrefix(original).header.subagentProtocolVersion).toBe(1)
    expect(await query.search('CURRENT_ORIGINAL_MARKER')).toHaveLength(1)
    const prior = await stat(path)
    const changedHeader = mode === 'metadata' ? { ...header, journal: { ...journal, legacyPrefixDigest: '0'.repeat(64) } }
      : mode === 'missing-journal' ? { ...header, journal: undefined }
        : mode === 'semantic-header' ? { ...header, semanticSeed: { version: 2, codec: 'semantic-seed-v2' } }
          : mode === 'protocol' ? { ...header, origin: 'fork' }
            : mode === 'future' ? { ...header, formatVersion: CURRENT_FORMAT_VERSION + 1 } : header
    const changedFrame = mode === 'frame' ? Buffer.from(frame.bytes.toString().replace('CURRENT_ORIGINAL_MARKER', 'CURRENT_CORRUPT__MARKER'))
      : mode === 'delivery' ? encodeFactBatch('invalid-delivery', journal.legacyPrefixDigest, [{ type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'foreign', generationId: 'g', originInputSeq: 100, seq: 0 }]).bytes : frame.bytes
    const changed = Buffer.concat([Buffer.from(JSON.stringify(changedHeader) + '\n'), changedFrame])
    await writeFile(path, changed)
    await utimes(path, prior.atime, new Date(prior.mtimeMs + 1000))
    expect(() => parseLinePrefix(changed)).toThrow()
    await expect(query.search('CURRENT_ORIGINAL_MARKER')).rejects.toMatchObject({ code: 'SESSION_QUERY_OBSERVE_FAILED' })
    await expect(query.search('CURRENT_ORIGINAL_MARKER')).rejects.toMatchObject({ code: 'SESSION_QUERY_OBSERVE_FAILED' })
    expect(await readFile(path)).toEqual(changed)
  } finally { closeSessionQueries() }
})

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

it.each([6, 11, 12, 13])('indexes only complete verified format%s groups and fingerprints the exact observed byte prefix without repairing a torn tail', async formatVersion => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-query-frames-')), path = join(root, 's.jsonl')
  const journal = metadata()
  const first = encodeFactBatch('first', journal.legacyPrefixDigest, [
    { type: 'tool/call', seq: 0, callId: 'c', name: 'probe', args: { z: 1, a: 2 } },
    { type: 'tool/result', seq: 1, callId: 'c', name: 'probe', output: 'FIRST_COMPLETE 中文😀' },
  ])
  const second = encodeFactBatch('second', decodeFactBatch(first.bytes).prefixDigest, [
    { type: 'turn/start', seq: 2 }, { type: 'user/message', seq: 3, text: 'SECOND_GROUP' }, { type: 'turn/end', seq: 4 },
  ])
  const header = Buffer.from(JSON.stringify({ formatVersion, sessionId: 's', createdAt: '2026-10-17T00:00:00Z', journal }) + '\n')
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

it.each([6, 11, 12, 13])('keeps exact inherited non-ASCII CRLF bytes in the structural format%s fingerprint', async formatVersion => {
  const legacy = Buffer.from(' { "type":"user/message", "seq":0, "text":"旧記録 中文😀" }\r\n')
  const journal = { ...metadata(), legacyBodyBytes: legacy.length, legacyEventCount: 1, legacyPrefixDigest: legacyPrefixDigest(1, legacy) }
  const frame = encodeFactBatch('after-legacy', journal.legacyPrefixDigest, [{ type: 'assistant/message', seq: 1, text: 'actual framed answer' }])
  const bytes = Buffer.concat([Buffer.from(JSON.stringify({ formatVersion, sessionId: 's', journal }) + '\n'), legacy, frame.bytes])
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
