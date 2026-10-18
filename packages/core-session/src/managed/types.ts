import type { Session, SessionEvent } from '../events/types.ts'

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type SessionView = DeepReadonly<Session>
export type SessionEventView = DeepReadonly<SessionEvent>
export type DeepMutable<T> = T extends (...args: never[]) => unknown ? T
  : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T
export type SeqRef<K extends SessionEvent['type']> =
  | { kind: 'prior'; seq: number; expectedType: K }
  | { kind: 'group'; position: number; expectedType: K }
export interface OwnerToken { readonly sessionId: string; readonly incarnation: string }
export interface BatchKey {
  readonly batchId: string; readonly firstSeq: number; readonly count: number; readonly previousPrefixDigest: string; readonly batchDigest: string
}
export interface FactReceipt { readonly owner: OwnerToken; readonly key: BatchKey; readonly lastSeq: number; readonly prefixDigest: string }
export type FactCode = 'FACT_CLOSED' | 'FACT_CANCELLED' | 'FACT_INVALID_GROUP' | 'FACT_CAPTURE_FAILED'
  | 'FACT_OWNER_UNSUPPORTED' | 'FACT_RECOVERY_REQUIRED' | 'FACT_PRECONDITION_STALE'
export type FactOutcome =
  | { kind: 'committed'; receipt: FactReceipt; seqs: readonly number[] }
  | { kind: 'absent' | 'unknown' | 'conflict'; key: BatchKey }
  | { kind: 'not-issued'; code: FactCode }
  | { kind: 'recovery-required'; code: 'FACT_INSTALL_FAILED'; receipt: FactReceipt }
export interface JournalPrefix { eventCount: number; bodyBytes: number; prefixDigest: string }
export interface JournalMetadata {
  version: 1; legacyBodyBytes: number; legacyEventCount: number; legacyPrefixDigest: string; separatorBytes: 0 | 1
}
export interface EncodedFactBatch { readonly key: BatchKey; readonly bytes: Uint8Array }

export class FactRecoveryRequiredError extends Error {
  readonly code = 'FACT_RECOVERY_REQUIRED'
  constructor() { super('Managed facts require reconciliation'); this.name = 'FactRecoveryRequiredError' }
}
