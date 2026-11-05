import type { SessionEvent } from '@i-harness/core-session'
import type { SessionMeta } from '../coordinator/types.ts'

/** One session read from a pre-commit-log generation (format 13/14). */
export type LegacySession = { readonly version: number; readonly events: readonly SessionEvent[]; readonly meta?: SessionMeta }

/** Read-only port over the legacy store; the composition supplies it (JSONL). */
export type LegacySessionStore = {
  read(sessionId: string): Promise<LegacySession>
  list(): Promise<string[]>
  /** Read-through for documents that predate the commit-log store. */
  readDocument?(key: string): Promise<unknown | undefined>
}
