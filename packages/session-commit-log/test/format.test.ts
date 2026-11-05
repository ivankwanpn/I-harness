import { describe, expect, it } from 'vitest'
import { COMMIT_FORMAT_VERSION, GENESIS_PREV, commitDigest, decodeCommit, encodeCommit } from '../src/format.ts'
import { scanCommitLog } from '../src/scanner.ts'

const header = { sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z', formatVersion: 14 }

function first() {
  return { v: COMMIT_FORMAT_VERSION as 15, seq: 1, prev: GENESIS_PREV, at: '2026-01-01T00:00:00.000Z', entries: [], ops: [{ kind: 'header' as const, value: header }] }
}

describe('commit codec', () => {
  it('round-trips a record and verifies its digest', () => {
    const payload = first()
    const line = encodeCommit(payload)
    expect(line).not.toContain('\n')
    const decoded = decodeCommit(line)
    expect(decoded.seq).toBe(1)
    expect(decoded.prev).toBe(GENESIS_PREV)
    expect(decoded.digest).toBe(commitDigest(payload))
    expect(decoded.ops[0]).toEqual({ kind: 'header', value: header })
  })

  it('rejects a record whose digest does not match its content', () => {
    const line = JSON.parse(encodeCommit(first())) as Record<string, unknown>
    line.at = '2026-01-01T00:00:00.001Z'
    expect(() => decodeCommit(JSON.stringify(line))).toThrowError(/digest/i)
  })

  it('rejects a foreign format version', () => {
    const line = encodeCommit({ ...first(), v: 14 as unknown as 15 })
    expect(() => decodeCommit(line)).toThrowError(/version/i)
  })

  it('keeps the digest stable across property order', () => {
    const a = first()
    const b = { ops: a.ops, at: a.at, prev: a.prev, seq: a.seq, v: a.v, entries: a.entries } as typeof a
    expect(commitDigest(a)).toBe(commitDigest(b))
    expect(encodeCommit(a)).toBe(encodeCommit(b))
  })

  it('rejects entries that are not lossless JSON', () => {
    const payload = { ...first(), entries: [{ type: 'x', value: 10n }] as never }
    expect(() => commitDigest(payload)).toThrow(/JSON/i)
  })

  it('rejects an unknown op kind', () => {
    const payload = { v: 15 as const, seq: 1, prev: GENESIS_PREV, at: 'x', entries: [], ops: [{ kind: 'nope' }] as never }
    expect(() => decodeCommit(JSON.stringify({ ...payload, digest: commitDigest(payload as never) }))).toThrowError(/op/i)
  })

  it('requires the header op exactly once, in the first commit', () => {
    const make = (seq: number, prev: string, ops: unknown[]) => {
      const payload = { v: COMMIT_FORMAT_VERSION as 15, seq, prev, at: 'x', entries: [], ops: ops as never[] }
      return JSON.stringify({ ...payload, digest: commitDigest(payload as never) })
    }
    const one = make(1, GENESIS_PREV, [{ kind: 'header', value: header }])
    const digest = JSON.parse(one).digest as string
    expect(() => scanCommitLog(new TextEncoder().encode(make(2, digest, [{ kind: 'header', value: header }]) + '\n'))).toThrowError(/header/i)
    expect(() => scanCommitLog(new TextEncoder().encode(make(1, GENESIS_PREV, []) + '\n'))).toThrowError(/header/i)
  })
})
