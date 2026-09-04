// packages/rewind/src/index.ts — M42 rewind engine (G1): backend snapshot /
// rollback. Storage layout `rewind/<sessionId>/{points.jsonl, blobs/<sha256>}`
// (spec §1), the fs-write-channel recorder (spec §2) and the embedded
// points/plan/execute service (spec §3).
export { RewindError, type RewindErrorCode } from "./error.ts"
export { normalizeRelPath, workspaceAbsPath } from "./path.ts"
export { RewindStore, sha256Hex, type RewindStoreOptions } from "./store.ts"
export { RewindRecorder, type RewindRecorderOptions, type RewindTakeResult } from "./recorder.ts"
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
  RewindPlan,
  RewindPoint,
  RewindPointSummary,
  RewindResult,
} from "./types.ts"
