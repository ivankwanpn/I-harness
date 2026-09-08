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

/**
 * M54 G2: one pre-image captured while a turn is still in flight.
 */
export interface RewindPendingEntry {
  /** Workspace-relative normalized key (same shape as RewindFileRecord.path). */
  path: string
  /** sha256 of the pre-image; null when the file did not exist (new file). */
  blobId: string | null
  isNewFile: boolean
}

/**
 * M54 G2: the durable sidecar of a turn that is still being recorded
 * (`rewind/<sessionId>/pending.json`). Written as the recorder takes
 * pre-images (blob first, then this record) and cleared only once the turn's
 * point is in the journal. A leftover sidecar after a crash is an UNFINISHED
 * turn: recovery archives it as an orphan — it is never fabricated into a
 * point and its pre-images are never auto-restored.
 */
export interface RewindPendingTurn {
  version: 1
  anchorSeq: number
  promptPreview: string
  /** Epoch ms of begin() — informational. */
  startedAt: number
  entries: RewindPendingEntry[]
}

/**
 * M54 G2: a leftover pending turn archived by recoverPending() into
 * `rewind/<sessionId>/orphaned.jsonl` (append-only — repeated crashes each
 * keep their own record).
 */
export interface RewindOrphanRecord extends RewindPendingTurn {
  /** Epoch ms when recovery archived it. */
  recoveredAt: number
}

/**
 * M54 G2: the plan-facing view of a crashed/unfinished turn. `files` are the
 * paths it touched; the pre-image blobs may still be in the store for a
 * MANUAL restore — the engine never applies them itself.
 */
export interface RewindOrphanedTurn {
  anchorSeq: number
  promptPreview: string
  files: string[]
  /** Absent when the sidecar is still in place (recovery has not run yet). */
  recoveredAt?: number
}

/**
 * M54 G3: `rewind/<sessionId>/meta.json` — the journal's workspace binding.
 * Written on the store's first write when a workspace is configured; a
 * pre-M54 journal without it stays readable (unknown workspace) and is
 * adopted by the first workspace that writes.
 */
export interface RewindWorkspaceMeta {
  version: 1
  /** Absolute workspace root the journal's relative paths resolve against. */
  workspace: string
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
  /** M54 G2: crashed/unfinished turns the journal still knows about (durable
   * pending sidecars + archived orphans). Their paths are also merged into
   * `unTracked`; no op is ever fabricated for them (honest, manual-only
   * recovery). Absent when there is nothing to report. */
  orphanedTurns?: RewindOrphanedTurn[]
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
