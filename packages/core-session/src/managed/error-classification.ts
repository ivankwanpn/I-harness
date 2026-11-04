/**
 * Machine-readable failure codes must survive cleanup aggregation.
 *
 * Fail-closed paths deliberately throw `FACT_RECOVERY_REQUIRED` so callers can
 * offer an explicit recovery instead of retrying. When such an error escapes
 * through a cleanup `AggregateError` (session/document close, writer
 * dependency settlement, request preparation), the code used to be lost: the
 * desktop then had nothing to branch on and showed an opaque message while the
 * composer stayed permanently unavailable.
 */

/** First machine-readable `code` found on the error, its aggregation members or its cause chain. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code.length > 0) return code
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = errorCode(inner)
      if (found !== undefined) return found
    }
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause === undefined || cause === error) return undefined
  return errorCode(cause)
}

/** Aggregate cleanup failures while keeping the recovery gate visible on the aggregate itself. */
export function aggregateErrors(errors: readonly unknown[], message: string): AggregateError {
  const aggregate = new AggregateError(errors, message)
  if (errors.some(error => errorCode(error) === 'FACT_RECOVERY_REQUIRED')) Object.assign(aggregate, { code: 'FACT_RECOVERY_REQUIRED' })
  return aggregate
}
