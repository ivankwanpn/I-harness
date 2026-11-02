import type { CapturedActionFact, CodeSettlementFact, ManagedAction, OwnerToken, ProducerFactOutcome, SettlementFacts, SettlementOwnerCut } from '@i-harness/core-session'

export interface Callback {
  invoke?: () => void
  state: 'unstarted' | 'running' | 'succeeded' | 'failed'
  reason?: unknown
}
export interface Pending {
  ordinal: number
  kind: 'output' | 'store' | 'reference' | 'terminal' | 'required'
  fact?: CapturedActionFact<ProducerFactOutcome>
  prepare?: () => Promise<CodeSettlementFact>
  capture?: () => CapturedActionFact<ProducerFactOutcome>
  source?: SettlementFacts<ProducerFactOutcome>
  expectedMember?: Readonly<{ type: CodeSettlementFact['type'] | 'code/store'; cellId: string }>
  expectedOwner?: Readonly<OwnerToken>
  nativeOutcome?: ProducerFactOutcome
  descriptor?: () => Promise<void>
  descriptorDone?: true
  descriptorFlight?: Promise<void>
  cell?: CellFacts
  actionCell?: CellFacts
  action?: ManagedAction<ProducerFactOutcome>
  attempted: boolean
  disposed: boolean
  cancelled: boolean
  cellClosed?: boolean
  settled: boolean
  failure?: { reason: unknown; sticky?: true }
  commit: Callback
  cancel: Callback
  settle: Callback
}
export interface CellFacts {
  action: ManagedAction<ProducerFactOutcome>
  source: SettlementFacts<ProducerFactOutcome>
  outputs: Set<Pending>
  recoveryRecords: Set<Pending>
  revision: number
  holdEpoch: number
  held: boolean
  sealed: boolean
  seal: Promise<void>
  sealNow(): void
  failure: Promise<never>
  fail(reason: unknown): void
  terminal?: Pending
  failed: boolean
  errors: unknown[]
}
export type PumpResult = { kind: 'idle' } | { kind: 'blocked'; reason: unknown } | { kind: 'close-cell'; record: Pending; cell: CellFacts }
export const callback = (invoke?: () => void): Callback => ({ invoke, state: 'unstarted' })
export const readCut = (cell: CellFacts): SettlementOwnerCut => ({ revision: cell.revision, pending: cell.outputs.size, recoveryPending: cell.recoveryRecords.size, failed: cell.failed })
export const sameCut = (cell: CellFacts, cut: SettlementOwnerCut) => {
  const current = readCut(cell)
  return current.revision === cut.revision && current.pending === cut.pending && current.recoveryPending === cut.recoveryPending && current.failed === cut.failed
}

/** Only the original retained invocation produces this private failure kind.
 * User error text/codes and retryable dispositions confer no such meaning. */
class OriginalPreparationFailure extends AggregateError {
  constructor(readonly reason: unknown) { super([reason], 'Original output preparation failed') }
}
export const originalPreparationFailure = (reason: unknown) => new OriginalPreparationFailure(reason)
export const isOriginalPreparationFailure = (reason: unknown): reason is OriginalPreparationFailure => reason instanceof OriginalPreparationFailure
