import { acquireSessionLock, lockPathFor, type SessionLock } from '@i-harness/fs-lock'

export type CommitLeaseOptions = {
  readonly lockRoot: string
  readonly retryMs?: number
  readonly deadlineMs?: number
}

export type CommitLease = { readonly held: boolean; release(): Promise<void> }

/** Exclusive writer lease keyed to the commit-log namespace, so a legacy
 *  coordinator lease and a commit-log lease never mask each other. */
export async function acquireCommitLease(sessionId: string, options: CommitLeaseOptions): Promise<CommitLease> {
  const lock: SessionLock = await acquireSessionLock({
    lockPath: lockPathFor(options.lockRoot, `commit-log:${sessionId}`),
    retryMs: options.retryMs,
    deadlineMs: options.deadlineMs,
  })
  let released = false
  return {
    get held() { return !released && lock.held },
    async release() { if (released) return; released = true; await lock.release() },
  }
}
