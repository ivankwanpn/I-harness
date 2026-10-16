import type { BatchKey, EncodedFactBatch, FactCode, FactReceipt, JournalPrefix, OwnerToken, SessionView, FactPorts, ManagedAction } from '@i-harness/core-session'

/** Constructed by the coordinator, bound to the actual held lease. Backend
 * implementers consume it; it is never handed to plugins or tool payloads. */
export interface HeldFactOwner {
  readonly owner: OwnerToken
  assertHeld(): void
}
export interface IssuingFactOwner extends HeldFactOwner { beforeIssue(): void }
export type BackendFactOutcome =
  | { kind: 'committed'; receipt: FactReceipt }
  | { kind: 'absent' | 'unknown' | 'conflict'; key: BatchKey }
  | { kind: 'not-issued'; code: FactCode }
export interface OwnedFactBackend {
  readJournalPrefix(sessionId: string, owner: HeldFactOwner): Promise<JournalPrefix>
  appendOwnedBatch(sessionId: string, owner: IssuingFactOwner, prefix: JournalPrefix, batch: EncodedFactBatch): Promise<BackendFactOutcome>
  reconcileOwnedBatch(sessionId: string, owner: HeldFactOwner, prefix: JournalPrefix, batch: EncodedFactBatch): Promise<BackendFactOutcome>
}

export interface ManagedDocument extends FactPorts {
  importSeed(events: readonly import('@i-harness/core-session').SessionEvent[]): Promise<import('@i-harness/core-session').FactOutcome>
  assertReady(): void
  readonly view: SessionView
  registerReceivedInputSource(drain: () => Promise<void>): import('@i-harness/core-session').ReceivedInputSource<import('@i-harness/core-session').FactOutcome>
  beginAction(signal?: AbortSignal): ManagedAction
  revokeNewWork(): void
  reconcile(key: BatchKey): Promise<import('@i-harness/core-session').FactOutcome>
  drain(): Promise<void>
  close(): Promise<void>
}
