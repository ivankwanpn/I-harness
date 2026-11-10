/**
 * Public surface of the commit-log core. Only what a consumer imports today is
 * exported; the format/scanner/fold modules stay internal until they have a
 * consumer (an unconsumed export fails the reachability gate).
 */
export { COMMIT_LOG_GENERATION, CommitLogConflictError, CommitLogNotFoundError, CommitLogClosedError, createCommitLog, openCommitLog } from './store.ts'
export type { CommitLog, CommitLogMode } from './store.ts'
