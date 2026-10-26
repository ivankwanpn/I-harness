import { replaySessionCodeStore } from '@i-harness/core-session/internal/bootstrap'
import type { SessionView } from '@i-harness/core-session'
import type { CodeModeStoreEntries } from './types.ts'

/** Existing admission/commit checks receive a complete store or exact fault. */
export function replayCodeModeStore(session: SessionView, sessionId?: string): CodeModeStoreEntries {
  const result = replaySessionCodeStore(session, sessionId)
  if (result.kind === 'limit-exceeded') throw new Error('Session store transfer limit exceeded')
  return result.entries.map(([key, value]) => [key, value])
}
