import { createHash } from 'node:crypto'
import { canonicalJsonData, type SessionEvent } from '@i-harness/core-session'
import { CommitFormatError } from './errors.ts'

/** Current commit-log format; a generation file's name carries the same number. */
export const COMMIT_FORMAT_VERSION = 15
/** Previous-digest of the first commit. */
export const GENESIS_PREV = '0'.repeat(64)

export type CommitOp =
  | { readonly kind: 'header'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'meta'; readonly patch: Readonly<Record<string, unknown>> }
  | { readonly kind: 'doc'; readonly key: string; readonly side: { readonly digest: string; readonly bytes: number } }
  | { readonly kind: 'doc-clear'; readonly key: string }
  | { readonly kind: 'intent'; readonly id: string; readonly intent: Readonly<Record<string, unknown>> }
  | { readonly kind: 'intent-done'; readonly id: string; readonly outcome: 'committed' | 'failed' }
  | { readonly kind: 'batch'; readonly id: string; readonly prefixDigest: string }
  | { readonly kind: 'seed'; readonly parent: string; readonly cut: number; readonly digest: string }
  | { readonly kind: 'rewind'; readonly toSeq: number }
  | { readonly kind: 'delete' }

export type CommitRecord = {
  readonly v: typeof COMMIT_FORMAT_VERSION
  readonly seq: number
  readonly prev: string
  readonly at: string
  readonly entries: readonly SessionEvent[]
  readonly ops: readonly CommitOp[]
  readonly digest: string
}

export type CommitPayload = Omit<CommitRecord, 'digest'>

const HEX64 = /^[0-9a-f]{64}$/

/** Lowercase hex sha256 over the canonical JSON of the record without its digest. */
export function commitDigest(payload: CommitPayload): string {
  return createHash('sha256').update(canonicalJsonData(payload)).digest('hex')
}

/** Canonical one-line encoding of a commit (no trailing newline). */
export function encodeCommit(payload: CommitPayload): string {
  const record: CommitRecord = { ...payload, digest: commitDigest(payload) }
  return canonicalJsonData(record)
}

/** Strict decode of one commit line; every field and op is validated. */
export function decodeCommit(line: string): CommitRecord {
  let value: unknown
  try { value = JSON.parse(line) } catch (cause) { throw new CommitFormatError('shape', 'commit line is not JSON', { cause }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommitFormatError('shape', 'commit line must be an object')
  const record = value as Record<string, unknown>
  if (record.v !== COMMIT_FORMAT_VERSION) throw new CommitFormatError('version', `unsupported commit format version ${String(record.v)}`)
  if (!Number.isSafeInteger(record.seq) || (record.seq as number) < 1) throw new CommitFormatError('shape', 'commit seq must be a positive safe integer')
  if (typeof record.prev !== 'string' || !HEX64.test(record.prev)) throw new CommitFormatError('shape', 'commit prev must be a 64-char hex digest')
  if (typeof record.at !== 'string' || record.at.length === 0) throw new CommitFormatError('shape', 'commit at must be a non-empty string')
  if (!Array.isArray(record.entries)) throw new CommitFormatError('shape', 'commit entries must be an array')
  if (!Array.isArray(record.ops)) throw new CommitFormatError('shape', 'commit ops must be an array')
  if (typeof record.digest !== 'string' || !HEX64.test(record.digest)) throw new CommitFormatError('shape', 'commit digest must be a 64-char hex digest')
  const ops = parseOps(record.ops)
  const headers = ops.filter(op => op.kind === 'header')
  if ((record.seq === 1) !== (headers.length === 1) || headers.length > 1) throw new CommitFormatError('ops', 'exactly one header op is required in the first commit')
  const payload: CommitPayload = { v: COMMIT_FORMAT_VERSION, seq: record.seq as number, prev: record.prev, at: record.at, entries: record.entries as SessionEvent[], ops }
  const digest = commitDigest(payload)
  if (digest !== record.digest) throw new CommitFormatError('digest', 'commit digest does not match its content')
  return { ...payload, digest }
}

export function parseOps(value: unknown): CommitOp[] {
  if (!Array.isArray(value)) throw new CommitFormatError('ops', 'commit ops must be an array')
  return value.map(parseOp)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new CommitFormatError('ops', `op ${field} must be a non-empty string`)
  return value
}

function requireBytes(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CommitFormatError('ops', 'doc side bytes must be a non-negative safe integer')
  return value as number
}

function requireObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommitFormatError('ops', `op ${field} must be an object`)
  return value as Record<string, unknown>
}

export function parseOp(value: unknown): CommitOp {
  const op = requireObject(value, 'kind')
  const kind = op.kind
  switch (kind) {
    case 'header': return { kind, value: requireObject(op.value, 'value') }
    case 'meta': return { kind, patch: requireObject(op.patch, 'patch') }
    case 'doc': {
      const side = requireObject(op.side, 'side')
      return { kind, key: requireString(op.key, 'key'), side: { digest: requireString(side.digest, 'digest'), bytes: requireBytes(side.bytes) } }
    }
    case 'doc-clear': return { kind, key: requireString(op.key, 'key') }
    case 'intent': return { kind, id: requireString(op.id, 'id'), intent: requireObject(op.intent, 'intent') }
    case 'intent-done': {
      if (op.outcome !== 'committed' && op.outcome !== 'failed') throw new CommitFormatError('ops', 'intent-done outcome must be committed or failed')
      return { kind, id: requireString(op.id, 'id'), outcome: op.outcome }
    }
    case 'batch': {
      if (typeof op.prefixDigest !== 'string' || !HEX64.test(op.prefixDigest)) throw new CommitFormatError('ops', 'batch prefixDigest must be a 64-char lowercase hex digest')
      return { kind, id: requireString(op.id, 'id'), prefixDigest: op.prefixDigest }
    }
    case 'seed': {
      if (!Number.isSafeInteger(op.cut) || (op.cut as number) < 0) throw new CommitFormatError('ops', 'seed cut must be a non-negative safe integer')
      return { kind, parent: requireString(op.parent, 'parent'), cut: op.cut as number, digest: requireString(op.digest, 'digest') }
    }
    case 'rewind': {
      if (!Number.isSafeInteger(op.toSeq) || (op.toSeq as number) < 0) throw new CommitFormatError('ops', 'rewind toSeq must be a non-negative safe integer')
      return { kind, toSeq: op.toSeq as number }
    }
    case 'delete': return { kind }
    default: throw new CommitFormatError('ops', `unknown op kind ${String(kind)}`)
  }
}
