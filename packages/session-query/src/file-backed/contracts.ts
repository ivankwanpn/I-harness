export type SessionQueryErrorCode =
  | "SESSION_QUERY_OBSERVE_FAILED" // scan/read/decode of the SOURCE failed — never serve stale rows
  | "SESSION_QUERY_INDEX_FOREIGN"  // the index file belongs to another application/newer version — refuse, never touch

export class SessionQueryError extends Error {
  readonly code: SessionQueryErrorCode
  constructor(code: SessionQueryErrorCode, message: string) {
    super(message)
    this.name = "SessionQueryError"
    this.code = code
  }
}

export function observeFailed(what: string, cause?: unknown): SessionQueryError {
  const detail = cause instanceof Error ? `: ${cause.message}` : ""
  return new SessionQueryError("SESSION_QUERY_OBSERVE_FAILED", `session query observe failed (${what})${detail}`)
}

export function foreignIndex(path: string, why: string): SessionQueryError {
  return new SessionQueryError(
    "SESSION_QUERY_INDEX_FOREIGN",
    `session query index at "${path}" is not owned by this harness (${why}); refusing to touch it`,
  )
}

export type InspectOutcome = "skip" | "indexed" | "content-equal" | "removed"

export interface FileBackedQueryOptions {
  /** JSONL store root (`<root>/<id>.jsonl`). */
  storeRoot: string
  /** Index file. Absent → ":memory:" (process-private, the default). */
  dbPath?: string
  /** Cooperative cancellation honored between reconcile phases. */
  signal?: AbortSignal
  /** Observability/trace hook (tests use it to assert single-inspection):
   * called once per store entry per reconcile round. */
  onInspect?: (sessionId: string, outcome: InspectOutcome) => void
}

export interface HeaderMeta {
  formatVersion: number
  sessionId: string
  createdAt: string
  parentSession?: string
  seedLength?: number
  delegationDepth?: number
  origin?: string
  journal?: import('@i-harness/core-session').JournalMetadata
}

export interface IndexedRow {
  id: string
  revision: string
  fingerprint: string
}

export interface SnapshotRow {
  revision: string
  file: string
}
