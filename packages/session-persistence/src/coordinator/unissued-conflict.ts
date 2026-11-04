import type { BackendFactOutcome } from './fact-types.ts'

/**
 * A conflict/unknown for a batch that was never issued is provably absent: no
 * byte of it reached the journal. Resolving it as absent lets the quarantine
 * clear (S-01) instead of requiring a restart, while an issued batch keeps the
 * fail-closed path because its durable fate may be unknown.
 */
export function resolveUnissuedConflict(outcome: BackendFactOutcome, issued: boolean): BackendFactOutcome {
  return (outcome.kind === 'conflict' || outcome.kind === 'unknown') && !issued
    ? { kind: 'absent', key: outcome.key }
    : outcome
}
