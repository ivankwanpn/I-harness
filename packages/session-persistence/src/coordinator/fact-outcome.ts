import { factPrefixDigest, type BatchKey, type FactCode, type OwnerToken } from '@i-harness/core-session'
import type { BackendFactOutcome } from './fact-types.ts'

function fields(value: unknown, names: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== names.length || names.some(name => !descriptors[name] || !('value' in descriptors[name]!))) return
  return value as Record<string, unknown>
}
export function sameBatchKey(value: unknown, expected: BatchKey): boolean {
  try {
    const row = fields(value, ['batchId', 'firstSeq', 'count', 'previousPrefixDigest', 'batchDigest'])
    return !!row && row.batchId === expected.batchId && row.firstSeq === expected.firstSeq && row.count === expected.count
      && row.previousPrefixDigest === expected.previousPrefixDigest && row.batchDigest === expected.batchDigest
  } catch { return false }
}

/** Backend data never retains a mutable alias into an issued key or receipt.
 * Invalid evidence preserves uncertainty over this exact owned batch. */
export function ownBackendOutcome(value: unknown, key: BatchKey, owner: OwnerToken, issued: boolean): BackendFactOutcome {
  const unknown = (): BackendFactOutcome => Object.freeze({ kind: 'unknown', key })
  try {
    const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value
    if (kind === 'committed') {
      if (!issued) return unknown()
      const envelope = fields(value, ['kind', 'receipt']), receipt = envelope && fields(envelope.receipt, ['owner', 'key', 'lastSeq', 'prefixDigest'])
      const scope = receipt && fields(receipt.owner, ['sessionId', 'incarnation'])
      if (!receipt || !scope || scope.sessionId !== owner.sessionId || scope.incarnation !== owner.incarnation || !sameBatchKey(receipt.key, key)
        || receipt.lastSeq !== key.firstSeq + key.count - 1 || receipt.prefixDigest !== factPrefixDigest(key.previousPrefixDigest, key.batchDigest)) return unknown()
      return Object.freeze({ kind, receipt: Object.freeze({ owner: Object.freeze({ ...owner }), key, lastSeq: key.firstSeq + key.count - 1, prefixDigest: receipt.prefixDigest as string }) })
    }
    if (kind === 'not-issued') {
      const envelope = fields(value, ['kind', 'code'])
      const codes: readonly FactCode[] = ['FACT_CLOSED', 'FACT_CANCELLED', 'FACT_INVALID_GROUP', 'FACT_CAPTURE_FAILED', 'FACT_OWNER_UNSUPPORTED', 'FACT_RECOVERY_REQUIRED']
      return !issued && envelope && codes.includes(envelope.code as FactCode) ? Object.freeze({ kind, code: envelope.code as FactCode }) : unknown()
    }
    if (kind === 'unknown' || kind === 'absent' || kind === 'conflict') {
      const envelope = fields(value, ['kind', 'key'])
      return envelope && sameBatchKey(envelope.key, key) ? Object.freeze({ kind, key }) : unknown()
    }
    return unknown()
  } catch { return unknown() }
}
