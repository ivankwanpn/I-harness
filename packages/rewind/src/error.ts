// packages/rewind/src/error.ts — the rewind engine's own failure vocabulary.
// Every guard the engine applies translates to one of these codes so a host
// can distinguish (a) path refusals from (b) missing blobs from (c) corrupted
// journal state without string matching.
export type RewindErrorCode =
  | "REWIND_PATH_REFUSED" // path guard: .. / absolute / empty (workspace-scope only)
  | "REWIND_BLOB_MISSING" // referenced pre-image blob does not exist in the store
  | "REWIND_STORE_CORRUPT" // points.jsonl parse failure (malformed line)
  | "REWIND_TARGET_INVALID" // plan/execute target turn index out of range
  | "REWIND_INVALID" // anything else structurally wrong (sessionId, blob id, truncate count)

export class RewindError extends Error {
  constructor(public readonly code: RewindErrorCode, message: string) {
    super(message)
    this.name = "RewindError"
  }
}
