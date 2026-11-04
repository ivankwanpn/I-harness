/**
 * A non-ready child birth is not automatically a recovery: the coordinator
 * distinguishes outcomes that proved nothing was published (`refused`,
 * `not-issued`) from a reservation that still needs reconciliation (`blocked`).
 * Treating every non-ready outcome as FACT_RECOVERY_REQUIRED left the parent
 * session unable to accept new work even when the child had clearly been
 * refused — the caller only had to report an ordinary tool failure.
 */

export type BirthFailureOutcome = { kind: string; reason?: unknown }

const subject = (label: "child" | "Team child") => (label === "child" ? "Original child birth" : "Original Team child birth")

/** Build the failure for a non-ready birth outcome, preserving the uncertain cases only. */
export function birthFailure(label: "child" | "Team child", outcome: BirthFailureOutcome): Error {
  const detail = `${outcome.kind}${outcome.reason !== undefined ? `: ${String(outcome.reason)}` : ""}`
  if (outcome.kind === "blocked") {
    return Object.assign(new Error(`${subject(label)} requires recovery (${detail})`), { code: "FACT_RECOVERY_REQUIRED" as const, outcome })
  }
  return Object.assign(new Error(`${subject(label)} was refused (${detail})`), { code: "FACT_BIRTH_REFUSED" as const, outcome })
}
