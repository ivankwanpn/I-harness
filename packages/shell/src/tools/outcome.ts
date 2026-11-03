import { declareToolResultOutcome, type ToolExec } from '@i-harness/core-tools'
import { execResultOutcome } from '@i-harness/exec'

/** Bind the original host identity before shell presentation projects its DTO. */
export function declareNativeResult(exec: ToolExec, result: unknown): void {
  declareToolResultOutcome(exec, execResultOutcome(result) ?? 'unknown')
}
