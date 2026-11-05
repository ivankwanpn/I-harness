import { describe, expect, it } from 'vitest'
import { COMMIT_FORMAT_VERSION, GENESIS_PREV, commitDigest } from '../src/format.ts'
import { scanCommitLog } from '../src/scanner.ts'

function line(seq: number, prev: string, ops: unknown[] = []) {
  const payload = { v: COMMIT_FORMAT_VERSION as 15, seq, prev, at: '2026-01-01T00:00:00.000Z', entries: [], ops }
  const digest = commitDigest(payload as never)
  return { line: JSON.stringify({ ...payload, digest }), digest }
}

const headerOp = (id: string) => ({ kind: 'header', value: { sessionId: id } })

describe('scanCommitLog', () => {
  it('returns every complete line', () => {
    const a = line(1, GENESIS_PREV, [headerOp('s')])
    const b = line(2, a.digest, [{ kind: 'meta', patch: { title: 't' } }])
    const result = scanCommitLog(new TextEncoder().encode(`${a.line}\n${b.line}\n`))
    expect(result.records.map(r => r.seq)).toEqual([1, 2])
    expect(result.tornBytes).toBe(0)
  })

  it('drops an incomplete trailing line', () => {
    const a = line(1, GENESIS_PREV, [headerOp('s')])
    const result = scanCommitLog(new TextEncoder().encode(`${a.line}\n${a.line.slice(0, 20)}`))
    expect(result.records).toHaveLength(1)
    expect(result.tornBytes).toBe(20)
  })

  it('rejects a complete line that is not a valid commit', () => {
    expect(() => scanCommitLog(new TextEncoder().encode('{"v":15}\n'))).toThrowError(/seq|shape/i)
  })

  it('rejects an out-of-order seq', () => {
    const a = line(2, GENESIS_PREV)
    expect(() => scanCommitLog(new TextEncoder().encode(`${a.line}\n`))).toThrowError(/seq/i)
  })

  it('rejects a broken prev chain', () => {
    const a = line(1, GENESIS_PREV, [headerOp('s')])
    const b = line(2, GENESIS_PREV, [{ kind: 'meta', patch: {} }])
    expect(() => scanCommitLog(new TextEncoder().encode(`${a.line}\n${b.line}\n`))).toThrowError(/prev/i)
  })

  it('returns an empty prefix for an empty log', () => {
    const result = scanCommitLog(new Uint8Array())
    expect(result.records).toHaveLength(0)
    expect(result.tornBytes).toBe(0)
  })
})
