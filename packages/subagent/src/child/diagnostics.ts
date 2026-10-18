import { diagnosticsFor } from "@i-harness/diagnostics"

// W6 T6: ONE module-scope handle for this file's one report, and the phase is
// `run`: the message is the spawn path's own — a role's declared tool is
// absent from the parent registry, so the child RUNS without it (a spawned
// child is a run of its own; the parent's turn is where the spawn happens).
// With nothing installed the handle delegates to console.warn verbatim (one
// argument) — unset mode is the pre-migration bytes.
export const d = diagnosticsFor("run")
