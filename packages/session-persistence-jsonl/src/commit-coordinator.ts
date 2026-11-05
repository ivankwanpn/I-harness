import { createJsonlBackend } from './backend-factory.ts'
import { createCommitCoordinator, type CommitCoordinator, type CommitCoordinatorOptions } from '@i-harness/session-persistence/internal/commit'

/**
 * The commit-log coordinator over a JSONL store root. Legacy format 13/14
 * sessions are read through the existing backend and migrate to a format-15
 * generation on their first write; the legacy file is never modified.
 */
export function createJsonlCommitCoordinator(root: string, options: Omit<CommitCoordinatorOptions, 'root' | 'legacy'> = {}): CommitCoordinator {
  const backend = createJsonlBackend(root)
  return createCommitCoordinator({
    ...options,
    root,
    legacy: {
      read: sessionId => backend.read(sessionId),
      list: () => backend.list(),
    },
  })
}
