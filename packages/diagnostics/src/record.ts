// packages/diagnostics/src/record.ts — the record vocabulary (M3 spec §3.3).
//
// TYPES ONLY, on purpose. The record is the contract shared by the hosts and by
// every migrated call site, so the shape is readable without following a factory;
// the two things that FILL it in (the error derivation, and the value scans of
// the redactor) live in their own modules beside this one.

/**
 * The four levels. They are a total order, and the logger's `level` option is a
 * THRESHOLD on that order: a record below the threshold is not written at all.
 * The order is the only behaviour attached to these strings — a sink writes the
 * string itself, and the console channel does not consult the order at all.
 */
export type Level = "debug" | "info" | "warn" | "error"

/**
 * A CLOSED union, enumerated from the MEASURED seams rather than invented: the
 * 107 `console.warn/error` sites in 34 files (W6 plan §0.1), plus the entries
 * those sites belong to — `cli` (argv, flags, subcommand usage), `config`
 * (settings, install, trust), `run` and `turn` (the run loop and its turns),
 * `sdk` and `acp` (the two non-interactive hosts), `session` (persistence and
 * the session commands), `mount` (the mount seams: mcp, lsp, skills, plugins,
 * agents), `telemetry` (its own sink errors), `shutdown` (teardown).
 *
 * It is closed so that a phase typo is a compile error at the call site instead
 * of a fifth spelling of "mount" in a log nobody greps. Adding a member is
 * therefore a decision, and the commit that adds one says which seam it came
 * from (W6 plan §0.3).
 */
export type DiagnosticPhase =
  | "cli"
  | "config"
  | "run"
  | "turn"
  | "sdk"
  | "acp"
  | "session"
  | "mount"
  | "telemetry"
  | "shutdown"

/**
 * The error half of a record — and it is DERIVED, never accepted: `message` and
 * `stack` have both been through the redactor before they land here. The reason
 * is measured, not theoretical: the four llm adapters throw errors whose message
 * is the provider's response body (`<model> request failed: 401 {...}`), which is
 * a body that can echo the credential back.
 *
 * Nothing in this package accepts a raw `Error` in its place; the derivation is
 * what the next task adds.
 */
export interface RedactedError {
  name: string
  message: string
  stack?: string
}

/** One line of the JSONL sink, and one structured record of a run. */
export interface DiagnosticRecord {
  ts: number
  level: Level
  run: string
  phase: DiagnosticPhase
  msg: string
  data?: Record<string, unknown>
  err?: RedactedError
  durMs?: number
}

/**
 * The seam that stands between a call site's values and a written record.
 * Declared here so the logger can require it BY CONSTRUCTION (no default, no
 * `undefined` overload): an un-redacted instance must be unbuildable, which is
 * the strongest of the three layers the design asks for.
 *
 * `redact` is the only way in; there is deliberately no `raw()` escape hatch, no
 * `unregister`, and no way to read the secret set back out of this handle. The
 * real implementation — key names, credential shapes, registered values — is its
 * own module; `size()` is the auditable part, so callers can say what the
 * coverage was instead of asserting it.
 */
export interface Redactor {
  redact(value: unknown, key?: string): unknown
  registerSecret(value: string): void
  size(): { rules: number; secrets: number }
}
