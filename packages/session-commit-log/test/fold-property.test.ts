import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@i-harness/core-session'
import { COMMIT_FORMAT_VERSION, GENESIS_PREV, decodeCommit, encodeCommit, type CommitOp, type CommitPayload, type CommitRecord } from '../src/format.ts'
import { foldCommits, type CommitView } from '../src/fold.ts'
import { scanCommitLog } from '../src/scanner.ts'

/** Deterministic xorshift so a failure is reproducible from the seed. */
function rng(seed: number) {
  let state = seed >>> 0
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 0x1_0000_0000 }
}
const pick = <T>(values: readonly T[], next: () => number): T => values[Math.floor(next() * values.length)]!
const hex = (next: () => number) => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(next() * 16)]).join('')

function generate(seed: number, commits: number): CommitRecord[] {
  const next = rng(seed), records: CommitRecord[] = []
  let prev = GENESIS_PREV, entriesTotal = 0
  for (let seq = 1; seq <= commits; seq++) {
    const ops: CommitOp[] = seq === 1 ? [{ kind: 'header', value: { sessionId: 's1', formatVersion: 15 } }] : []
    const entries = Array.from({ length: Math.floor(next() * 3) }, (_, at): SessionEvent => ({ type: 'user/message', text: 'm' + seq + '-' + at }))
    const roll = next()
    if (roll < 0.2) ops.push({ kind: 'meta', patch: { tag: 'k' + Math.floor(next() * 3) } })
    else if (roll < 0.4) ops.push({ kind: 'doc', key: pick(['a', 'b', 'c'], next), side: { digest: hex(next), bytes: Math.floor(next() * 1000) } })
    else if (roll < 0.5) ops.push({ kind: 'doc-clear', key: pick(['a', 'b', 'c'], next) })
    else if (roll < 0.65) ops.push({ kind: 'intent', id: 'i' + Math.floor(next() * 2), intent: { at: seq } })
    else if (roll < 0.75) ops.push({ kind: 'intent-done', id: 'i' + Math.floor(next() * 2), outcome: pick(['committed', 'failed'] as const, next) })
    else if (roll < 0.85) ops.push({ kind: 'batch', id: 'b' + seq, prefixDigest: hex(next) })
    else if (roll < 0.92) ops.push({ kind: 'rewind', toSeq: Math.floor(next() * (entriesTotal + entries.length + 1)) })
    else if (roll < 0.95) ops.push({ kind: 'seed', parent: 'p', cut: Math.floor(next() * 5), digest: hex(next) })
    else if (roll < 0.97) ops.push({ kind: 'delete' })
    const payload: CommitPayload = { v: COMMIT_FORMAT_VERSION, seq, prev, at: '2026-01-01T00:00:00.000Z', entries, ops }
    const record = decodeCommit(encodeCommit(payload))
    records.push(record)
    prev = record.digest
    entriesTotal = seq === 1 ? entries.length : entriesTotal + entries.length
  }
  return records
}

/** Independent reference implementation of the documented fold semantics. */
function model(records: readonly CommitRecord[]): CommitView {
  let header: Readonly<Record<string, unknown>> | undefined
  let entries: SessionEvent[] = []
  const meta: Record<string, unknown> = {}, documents = new Map<string, { digest: string; bytes: number }>(), intents = new Map<string, Readonly<Record<string, unknown>>>(), batches = new Map<string, string>()
  let seed: { parent: string; cut: number; digest: string } | undefined, deleted = false
  for (const record of records) {
    entries = [...entries, ...record.entries]
    for (const op of record.ops) {
      if (op.kind === 'header') { if (!header) header = op.value }
      else if (op.kind === 'meta') Object.assign(meta, op.patch)
      else if (op.kind === 'doc') documents.set(op.key, op.side)
      else if (op.kind === 'doc-clear') documents.delete(op.key)
      else if (op.kind === 'intent') intents.set(op.id, op.intent)
      else if (op.kind === 'intent-done') intents.delete(op.id)
      else if (op.kind === 'batch') batches.set(op.id, op.prefixDigest)
      else if (op.kind === 'seed') { if (!seed) seed = { parent: op.parent, cut: op.cut, digest: op.digest } }
      else if (op.kind === 'rewind') {
        if (op.toSeq > entries.length) throw new Error('rewind beyond entries')
        entries = entries.slice(0, op.toSeq)
      } else if (op.kind === 'delete') deleted = true
    }
  }
  if (!header) throw new Error('missing header')
  return { header, entries, meta, documents, intents, batches, ...(seed ? { seed } : {}), deleted }
}

describe('fold property', () => {
  for (const seed of [1, 7, 42, 99, 1234]) {
    it('matches the reference model for seed ' + seed, () => {
      const records = generate(seed, 25)
      const scanned = scanCommitLog(Buffer.from(records.map(record => encodeCommit({ v: record.v, seq: record.seq, prev: record.prev, at: record.at, entries: record.entries, ops: record.ops })).join('\n') + '\n'))
      expect(scanned.records).toEqual(records)
      expect(scanned.tornBytes).toBe(0)
      expect(foldCommits(scanned.records)).toEqual(model(records))
    })
  }
})