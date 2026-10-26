/** Browser-safe public fork data. No Node/engine/SDK transport runtime edge. */
export * from '@i-harness/session-persistence/fork-contract'
import type { ForkOperation, ForkOutcome } from '@i-harness/session-persistence/fork-contract'
export interface ForkClientAttempt {
  readonly operation: ForkOperation
  readonly lastOutcome: ForkOutcome | undefined
  run(): Promise<ForkOutcome>
}
