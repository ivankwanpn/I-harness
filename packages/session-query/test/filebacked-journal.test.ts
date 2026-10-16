import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFactBatch, decodeFactBatch, legacyPrefixDigest } from '@i-harness/core-session'
import { createFileBackedSessionQuery, closeSessionQueries } from '../src/index.ts'
import { parseLinePrefix } from '../src/file-backed/inspection.ts'

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const metadata = () => ({ version: 1, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 }) as const

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
      : mode === 'future' ? Buffer.concat([Buffer.from(JSON.stringify({ ...header, formatVersion: 7 }) + '\n'), frame.bytes])
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
