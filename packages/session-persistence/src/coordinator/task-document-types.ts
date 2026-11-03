// Tokens are minted only by their future original operation owner.
declare const witnessBrand: unique symbol
declare const ackBrand: unique symbol
declare const scopeBrand: unique symbol

export interface TaskDocumentWitness { readonly [witnessBrand]: true }
export interface TaskDocumentAck { readonly [ackBrand]: true }
export interface HeldTaskDocumentScope {
  readonly [scopeBrand]: true
  readonly parentSessionId: string
  readonly key: string
  assertActive(): void
}
export type TaskObservation =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'present'; value: unknown; witness: TaskDocumentWitness }>
export type Confirmation =
  | Readonly<{ kind: 'confirmed'; ack: TaskDocumentAck; durability: 'file-synced-process-restart-v1'; cleanupPending: boolean }>
  | Readonly<{ kind: 'unknown'; cause: unknown; cleanupPending: boolean }>
  | Readonly<{ kind: 'conflict'; cleanupPending: boolean }>
export interface RawTaskObservation {
  readonly kind: 'present'
  readonly value: unknown
  readonly witness: TaskDocumentWitness
}
export interface TaskDocumentBackendSession {
  observe(): Promise<Readonly<{ kind: 'absent' }> | RawTaskObservation>
  confirm(witness: TaskDocumentWitness): Promise<Confirmation>
  settleResources(): Promise<void>
  stageWrite?(witness: TaskDocumentWitness, bytes: Uint8Array): TaskDocumentWrite
}
export type TaskWriteOutcome = Readonly<{ kind: 'not-issued'; reason: 'cancelled' | 'revoked' | 'unsupported'; cleanupPending: boolean }> | Readonly<{ kind: 'unknown'; cause: unknown; cleanupPending: boolean }> | Readonly<{ kind: 'conflict'; cleanupPending: boolean }> | Readonly<{ kind: 'committed'; ack: TaskDocumentAck; durability: 'file-synced-process-restart-v1'; cleanupPending: boolean }>
export interface TaskDocumentWrite { issue(): Promise<TaskWriteOutcome>; reconcile(): Promise<TaskWriteOutcome>; retry(): Promise<TaskWriteOutcome>; outcome(): TaskWriteOutcome | undefined }
export type OpenTaskDocumentSession = (scope: HeldTaskDocumentScope) => TaskDocumentBackendSession
