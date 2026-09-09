// packages/rewind/src/index.ts — M42 rewind engine (G1): backend snapshot /
// rollback. Storage layout `rewind/<sessionId>/{points.jsonl, blobs/<sha256>}`
// (spec §1), the fs-write-channel recorder (spec §2) and the embedded
// points/plan/execute service (spec §3). M54 adds two additive sidecars to the
// same dir: meta.json (G3 workspace binding) and pending.json/orphaned.jsonl
// (G2 durable mid-turn crash recovery).
export { RewindError, type RewindErrorCode } from "./error.ts"
export { normalizeRelPath, workspaceAbsPath } from "./path.ts"
export { RewindStore, sha256Hex, type RewindStoreOptions } from "./store.ts"
export { RewindRecorder, type RewindRecorderOptions, type RewindTakeResult } from "./recorder.ts"
export { createGitProbe, createGitProbeForStore, type GitExec, type GitExecOptions, type GitProbe, type GitProbeOptions } from "./git-probe.ts"
export {
  RewindService,
  type RewindServiceOptions,
  type RewindExecuteHooks,
} from "./service.ts"
export type {
  ConflictOp,
  ConflictType,
  FileOp,
  FileStatus,
  RewindEvent,
  RewindExecuteError,
  RewindFileRecord,
  RewindMode,
  RewindOrphanedTurn,
  RewindOrphanRecord,
  RewindPendingEntry,
  RewindPendingTurn,
  RewindPlan,
  RewindPoint,
  RewindPointSummary,
  RewindResult,
  RewindWorkspaceMeta,
  UnseenChange,
  UnseenChangeKind,
} from "./types.ts"
