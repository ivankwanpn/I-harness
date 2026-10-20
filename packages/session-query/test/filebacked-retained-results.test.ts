import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { encodeFactBatch, legacyPrefixDigest, type ResultEnvelope, type SessionEvent } from '@i-harness/core-session'
import { closeSessionQueries, createFileBackedSessionQuery } from '../src/index.ts'

const ref = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 500, contentDigest: 'c'.repeat(64), completeness: 'source-limited' } as const
const media = [{ mediaType: 'image/png', dataBase64: 'aGVsbG8=', name: 'TYPED_MEDIA_SECRET' }] as const
const value = { images: 'INLINE_IMAGES_MARKER', error: 'INLINE_ERROR_MARKER', ref: 'INLINE_REF_MARKER', nested: { type: 'image', data: 'INLINE_NESTED_MARKER' } }
const inline: ResultEnvelope = { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media,
  retention: { kind: 'inline', value, encodedBytes: Buffer.byteLength(JSON.stringify(value)) }, dependencies: { kind: 'artifact-set', ref, count: 1 } }
const artifact: ResultEnvelope = { ...inline, execution: { outcome: 'failed', dispatch: 'dispatched' }, preview: 'RETAINED_VISIBLE_MARKER', retention: { kind: 'artifact', ref } }
const unavailable: ResultEnvelope = { ...inline, preview: 'UNAVAILABLE_VISIBLE_MARKER', retention: { kind: 'unavailable', reason: 'quota' } }

function facts(envelope: ResultEnvelope): SessionEvent[] {
  return [
    { type: 'user/message', seq: 0, text: 'REQUEST_MARKER' },
    { type: 'tool/call', seq: 1, callId: 'tool', name: 'read', args: {} },
    { type: 'tool/result', seq: 2, callId: 'tool', name: 'read', envelope },
    { type: 'code/call', seq: 3, cellId: 'cell', callId: 'code', name: 'read', args: {} },
    { type: 'code/result', seq: 4, cellId: 'cell', callId: 'code', name: 'read', envelope },
    { type: 'code/output', seq: 5, cellId: 'cell', envelope },
    { type: 'subagent/end', seq: 6, version: 1, taskId: 'child', outcome: 'completed', resultRevision: 'original', resultText: 'LEGACY_SHADOW', envelope },
    { type: 'job/status', seq: 7, version: 1, job: { jobId: 'j', kind: 'subagent', label: 'job', status: 'completed', outputAvailable: true, result: { version: 1, kind: 'retained', revision: 'original', envelope } } },
  ]
}
function framed(formatVersion: number, events: SessionEvent[]): Buffer {
  const journal = { version: 1, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 }
  const frame = encodeFactBatch('retained-search', journal.legacyPrefixDigest, events)
  return Buffer.concat([Buffer.from(JSON.stringify({ formatVersion, sessionId: 's', createdAt: '2026-10-20T00:00:00Z', journal }) + '\n'), frame.bytes])
}
function fixture(bytes: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'ih-query-retained-')), file = join(dir, 's.jsonl'), dbPath = join(dir, 'query.db')
  writeFileSync(file, bytes)
  return { dir, file, dbPath, cleanup() { closeSessionQueries(); rmSync(dir, { recursive: true, force: true }) } }
}
const expected = [
  { sessionId: 's', seq: 2, eventType: 'tool/result' }, { sessionId: 's', seq: 4, eventType: 'code/result' },
  { sessionId: 's', seq: 5, eventType: 'code/output' }, { sessionId: 's', seq: 6, eventType: 'subagent/end' },
]

describe('retained results through actual framed JSONL and file-backed FTS', () => {
  it.each([
    ['inline', inline, ['INLINE_IMAGES_MARKER', 'INLINE_ERROR_MARKER', 'INLINE_REF_MARKER', 'INLINE_NESTED_MARKER']],
    ['artifact', artifact, ['RETAINED_VISIBLE_MARKER']],
    ['unavailable', unavailable, ['UNAVAILABLE_VISIBLE_MARKER']],
  ] as const)('indexes bounded %s content, event identity and snippets without source writes', async (_kind, envelope, markers) => {
    const bytes = framed(10, facts(envelope)), store = fixture(bytes)
    try {
      const query = createFileBackedSessionQuery({ storeRoot: store.dir, dbPath: store.dbPath })
      for (const marker of markers) {
        const hits = await query.search(marker)
        expect(hits.map(({ sessionId, seq, eventType }) => ({ sessionId, seq, eventType })).sort((a, b) => a.seq - b.seq)).toEqual(expected)
        for (const hit of hits) expect(hit.snippet).toContain(marker)
      }
      // A valid immutable descriptor has no body-read authority. Its body need
      // not be present for search; only the recorded preview is searchable.
      for (const hidden of [ref.id, ref.revision, ref.contentDigest, ref.codec, 'source-limited', 'artifact-set', 'TYPED_MEDIA_SECRET', 'aGVsbG8', 'ONLY_IN_ARTIFACT_BODY', 'LEGACY_SHADOW']) expect(await query.search(hidden)).toEqual([])
      expect(readFileSync(store.file)).toEqual(bytes)
    } finally { store.cleanup() }
  })

  it('rebuilds a literal owned version1 empty projection with unchanged source revision and fingerprint', async () => {
    const bytes = framed(10, facts(artifact)), store = fixture(bytes)
    try {
      const sourceStat = statSync(store.file)
      const initial = createFileBackedSessionQuery({ storeRoot: store.dir, dbPath: store.dbPath })
      expect(await initial.search('REQUEST_MARKER')).toHaveLength(1)
      closeSessionQueries()
      const old = new DatabaseSync(store.dbPath)
      const indexed = old.prepare('SELECT * FROM indexed_sessions').all()
      expect(indexed).toHaveLength(1)
      old.exec("UPDATE indexed_docs SET text='' WHERE event_type IN ('tool/result','code/result','code/output','subagent/end'); PRAGMA user_version=1")
      expect(old.prepare('SELECT * FROM indexed_sessions').all()).toEqual(indexed)
      old.close()
      const outcomes: string[] = []
      const reopened = createFileBackedSessionQuery({ storeRoot: store.dir, dbPath: store.dbPath, onInspect: (_id, outcome) => outcomes.push(outcome) })
      expect((await reopened.search('RETAINED_VISIBLE_MARKER')).map(hit => hit.seq).sort()).toEqual([2, 4, 5, 6])
      expect(outcomes).toEqual(['indexed'])
      outcomes.length = 0
      expect(await reopened.search('RETAINED_VISIBLE_MARKER')).toHaveLength(4)
      expect(outcomes).toEqual(['skip'])
      closeSessionQueries()
      const check = new DatabaseSync(store.dbPath, { readOnly: true })
      try {
        expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
        expect(check.prepare('SELECT * FROM indexed_sessions').all()).toEqual(indexed)
      } finally { check.close() }
      expect(readFileSync(store.file)).toEqual(bytes)
      expect(statSync(store.file)).toMatchObject({ size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, ctimeMs: sourceStat.ctimeMs, ino: sourceStat.ino })
    } finally { store.cleanup() }
  })

  it.each([8, 9])('reads literal predecessor format%s raw results without admitting new envelopes', async format => {
    const raw: SessionEvent[] = [{ type: 'tool/call', seq: 0, callId: 'legacy', name: 'read', args: {} }, { type: 'tool/result', seq: 1, callId: 'legacy', name: 'read', output: 'LEGACY_VISIBLE_MARKER' }]
    const bytes = framed(format, raw), store = fixture(bytes)
    try {
      const query = createFileBackedSessionQuery({ storeRoot: store.dir })
      expect(await query.search('LEGACY_VISIBLE_MARKER')).toEqual([expect.objectContaining({ seq: 1, eventType: 'tool/result' })])
      expect(readFileSync(store.file)).toEqual(bytes)
    } finally { store.cleanup() }
    const invalid = fixture(framed(format, facts(artifact)))
    try {
      const query = createFileBackedSessionQuery({ storeRoot: invalid.dir })
      await expect(query.search('RETAINED_VISIBLE_MARKER')).rejects.toMatchObject({ code: 'SESSION_QUERY_OBSERVE_FAILED' })
      expect(readFileSync(invalid.file)).toEqual(framed(format, facts(artifact)))
    } finally { invalid.cleanup() }
  })

  it('refuses literal future source format11 without rewriting the file', async () => {
    const bytes = framed(11, facts(artifact)), store = fixture(bytes)
    try {
      const query = createFileBackedSessionQuery({ storeRoot: store.dir })
      await expect(query.search('REQUEST_MARKER')).rejects.toMatchObject({ code: 'SESSION_QUERY_OBSERVE_FAILED' })
      expect(readFileSync(store.file)).toEqual(bytes)
    } finally { store.cleanup() }
  })

  it.each(['foreign', 'future3'] as const)('refuses %s derived databases without resetting their tables or bytes', kind => {
    const store = fixture(framed(10, facts(artifact)))
    try {
      const db = new DatabaseSync(store.dbPath)
      db.exec(`CREATE TABLE sentinel (text TEXT); INSERT INTO sentinel VALUES ('preserve'); PRAGMA application_id=${kind === 'foreign' ? '0x4948524E' : '0x49485155'}; PRAGMA user_version=${kind === 'foreign' ? 1 : 3}`)
      db.close()
      const before = readFileSync(store.dbPath)
      expect(() => createFileBackedSessionQuery({ storeRoot: store.dir, dbPath: store.dbPath })).toThrowError(expect.objectContaining({ code: 'SESSION_QUERY_INDEX_FOREIGN' }))
      expect(readFileSync(store.dbPath)).toEqual(before)
      const check = new DatabaseSync(store.dbPath, { readOnly: true })
      try { expect(check.prepare('SELECT * FROM sentinel').all()).toEqual([{ text: 'preserve' }]) } finally { check.close() }
    } finally { store.cleanup() }
  })

  it('rolls back the owned predecessor rebuild when DDL fails after an earlier table drop', async () => {
    const store = fixture(framed(10, facts(artifact)))
    try {
      const query = createFileBackedSessionQuery({ storeRoot: store.dir, dbPath: store.dbPath })
      expect(await query.search('REQUEST_MARKER')).toHaveLength(1)
      closeSessionQueries()
      const old = new DatabaseSync(store.dbPath)
      const lineage = old.prepare('SELECT * FROM lineage').all(), indexed = old.prepare('SELECT * FROM indexed_sessions').all()
      // Real SQLite rejects DROP TABLE on this view after lineage was dropped.
      old.exec('DROP TABLE indexed_docs; CREATE VIEW indexed_docs AS SELECT * FROM indexed_sessions; PRAGMA user_version=1')
      old.close()
      expect(() => createFileBackedSessionQuery({ storeRoot: store.dir, dbPath: store.dbPath })).toThrow(/view/)
      const check = new DatabaseSync(store.dbPath, { readOnly: true })
      try {
        expect(check.prepare('SELECT * FROM lineage').all()).toEqual(lineage)
        expect(check.prepare('SELECT * FROM indexed_sessions').all()).toEqual(indexed)
        expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
        expect(check.prepare("SELECT type FROM sqlite_schema WHERE name='indexed_docs'").get()).toEqual({ type: 'view' })
      } finally { check.close() }
    } finally { store.cleanup() }
  })
})
