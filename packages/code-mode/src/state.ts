import { replayLegacyCodeStore } from '@i-harness/core-session/internal/bootstrap'
import type { SessionView } from '@i-harness/core-session'
import type { CodeModeStoreEntries } from './types.ts'

/** Raw legacy replay retains its optional-seq and array-order contract. */
export function replayCodeModeStore(session: SessionView, sessionId?: string): CodeModeStoreEntries {
  return replayLegacyCodeStore(session, sessionId).map(([key, value]) => [key, value])
}
