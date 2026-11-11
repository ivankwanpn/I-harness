import { acquireSessionLock, lockPathFor, type SessionLock } from '@i-harness/fs-lock'
import { LeaseRetirement } from '@i-harness/fs-lock/internal/lease-retirement'

export type CommitLeaseOptions = {
  readonly lockRoot: string
  readonly retryMs?: number
  readonly deadlineMs?: number
}

export type CommitLease = LeaseRetirement

/** Exclusive writer lease keyed to the commit-log namespace, so a legacy
 *  coordinator lease and a commit-log lease never mask each other. */
export async function acquireCommitLease(sessionId: string, options: CommitLeaseOptions): Promise<CommitLease> {
  const lock: SessionLock = await acquireSessionLock({
    lockPath: lockPathFor(options.lockRoot, `commit-log:${sessionId}`),
    retryMs: options.retryMs,
    deadlineMs: options.deadlineMs,
  })
  return retainLease(lock)
}

/** Readers retain every sidecar in their original prefix until close. */
export async function acquireCommitSnapshotLease(sessionId: string, options: CommitLeaseOptions, mode: 'shared' | 'exclusive'): Promise<CommitLease> {
  const lock = await acquireSessionLock({
    lockPath: lockPathFor(options.lockRoot, `commit-log-snapshots:${sessionId}`),
    mode,
    retryMs: options.retryMs,
    deadlineMs: options.deadlineMs,
  })
  return retainLease(lock)
}

function retainLease(lock: SessionLock): CommitLease {
  return new LeaseRetirement(lock)
}
