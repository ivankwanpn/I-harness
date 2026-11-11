import { CommitLogCleanupError, CommitLogNotFoundError, openCommitLog, type CommitLog, type CommitLogCleanup } from '@i-harness/session-commit-log'

/** A doc or doc-clear permanently claims its key for the committed namespace.
 * Read the actual log, including checkpoint-retained clears; absence alone
 * permits an original legacy writer to continue under its document lease. */
export async function isCommittedDocumentClaimed(root: string, key: string, retain?: (cleanup: CommitLogCleanup, cause: unknown) => void): Promise<boolean> {
  let log: CommitLog
  try { log = await openCommitLog({ root, sessionId: '__documents__' }, 'read') }
  catch (error) {
    if (error instanceof CommitLogNotFoundError) return false
    if (error instanceof CommitLogCleanupError) retain?.(error.cleanup, error)
    throw error
  }
  let failed = false, primary: unknown, claimed = false
  try {
    claimed = log.view().documents.has(key) || log.records().some(record => record.ops.some(op => op.kind === 'doc-clear' && op.key === key))
  } catch (error) { failed = true; primary = error }
  try { await log.close() }
  catch (cleanup) {
    const error = new CommitLogCleanupError(failed ? [primary, cleanup] : [cleanup], log)
    retain?.(log, error)
    throw error
  }
  if (failed) throw primary
  return claimed
}
