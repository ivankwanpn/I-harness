// packages/rewind/src/types.ts — the shared shapes of the rewind engine (spec
// §1 RewindPoint + §3 service vocabulary). STAYS dependency-free: nothing here
// imports core-session or fs — the assembly layer translates the RewindEvent
// into the session-log entry (core-session owns the union member).

/** What a turn did to one file (as observed at finalize). */
export type FileStatus = "added" | "modified" | "deleted"

export interface RewindFileRecord {
  /** Workspace-relative normalized key (`src/a.txt`, never absolute / `..`). */
  path: string
  /** "added" → the file did not exist at the first recorded write of the turn;
   * "deleted" → it existed before but is gone at turn end; else "modified". */
  status: FileStatus
  /** Blob id (sha256 hex) of the byte-exact PRE-image (state before the turn).
   * Present iff the file existed at the first recorded write. */
  preBlob?: string
  /** True iff the file was NEW (no pre-image) — the plan turns this into a
   * delete-added restore op. Mirrors `status === "added"`. */
  isNewFile?: boolean
  /** sha256 hex of the file content re-read at finalize (cheap: touched set
   * only). Absent when the file is missing at turn end (deleted). */
  afterHash?: string
}

export interface RewindPoint {
  /** 0-based sequence index; equals the point's line index in points.jsonl. */
  turnIndex: number
  /** First event seq of the turn (the anchor user/message) — G2's
   * deriveMessages cutSeq resolves its rewind window from this. */
  anchorSeq: number
  /** Short user prompt preview for the points() UI list. */
  promptPreview: string
  files: RewindFileRecord[]
}

export type RewindMode = "all" | "files" | "conversation"

/** One file operation execute() would perform (or performed). */
export interface FileOp {
  path: string
  /** `restore-blob` — rewrite the file from its pre-image blob (the target
   * point's preBlob). `delete-added` — remove a file the target turn created. */
  kind: "restore-blob" | "delete-added"
  /** The blob id to restore from (restore-blob only). */
  blobId?: string
}

export type ConflictType = "modified" | "deleted" | "created"

/** A path whose current disk state differs from the target turn's recorded
 * after-state (externally changed since the target turn ended). */
export interface ConflictOp {
  path: string
  /** "modified" — content differs / file existed at target, gone now →
   * "deleted" — file absent at target, present now → "created". */
  kind: ConflictType
}

/**
 * RewindPlan — the lazy two-phase dry run (spec §3). Diagnostics are
 * mode-independent (`clean`/`conflicts`/`unTracked`); `ops` is the mode's
 * executable list (empty for a "conversation" restore — no file ops).
 *
 * unTracked semantics (v1 honest scope): paths touched in recorded turns
 * AFTER the target that are NOT in the target point's set — the restore does
 * not touch them, and their later tool records vanish from the conversation
 * projection. Shell-only changes (the recorder never saw them) are entirely
 * invisible to the engine — a documented v1 limitation (the engine cannot
 * diff a disk it never watched).
 */
export interface RewindPlan {
  target: number
  mode: RewindMode
  clean: FileOp[]
  conflicts: ConflictOp[]
  unTracked: string[]
  ops: FileOp[]
}

export interface RewindPointSummary {
  turnIndex: number
  preview: string
  files: number
}

/**
 * The durable conversation marker appended by execute() — mirror of the
 * core-session `rewind/point` union member (G2 owns the projection semantics:
 * deriveMessages hides [anchorSeq, marker) via rewindCuts). The rewind
 * package declares it WITHOUT importing core-session so the package stays
 * dependency-free; the assembly maps it into the session log structurally.
 */
export interface RewindEvent {
  type: "rewind/point"
  version: 1
  targetTurn: number
  anchorSeq: number
  mode: RewindMode
  fileOps: Array<{ path: string; op: "restore" | "delete" }>
}

export interface RewindExecuteError {
  path: string
  message: string
}

export interface RewindResult {
  target: number
  mode: RewindMode
  /** File ops that completed (restore-blob / delete-added). */
  revertedFiles: number
  conflicts: ConflictOp[]
  /** Non-empty ⇒ had_errors ⇒ points.jsonl is KEPT (retry data, spec §3). */
  errors: RewindExecuteError[]
  /** True when points.jsonl was truncated to before the target turn. */
  truncated: boolean
  eventAppended: boolean
}
