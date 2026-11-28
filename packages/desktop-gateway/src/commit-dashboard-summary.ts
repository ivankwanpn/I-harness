import type { SessionMeta, SessionCoordinator } from '@i-harness/session-persistence'
import type { CommitCoordinator } from '@i-harness/session-persistence/internal/commit'
import { describeSavedSession } from './session-dashboard-summary.ts'
import { isConversationMetadata } from './session-visibility.ts'

type Summary = ReturnType<typeof describeSavedSession>
type Entry = { meta: SessionMeta; updatedAt: number; current: () => Promise<boolean>; saved?: { summary: Summary } }
type Source = Pick<SessionCoordinator, 'profile'> & Pick<CommitCoordinator, 'list'>

/** Membership still reads and validates each native commit chain. The terminal
 * digest identifies every committed byte relevant to the display projection. */
export function createCommitDashboardSummaryCache() {
  const saved = new Map<string, { digest: string; summary: NonNullable<Summary> }>()
  function forListing(root: string, source: Source, needsSavedSummary: (id: string) => boolean = () => true) {
    // Full metadata is available to the original visibility check only during
    // this enumeration. The cache above never retains a header or transcript.
    const rows = new Map<string, Entry>()
    return {
      list(onUnreadable?: () => void, onlyId?: string) {
        return source.list(onUnreadable, onlyId, ({ id, meta, updatedAt, digest, current, snapshot }) => {
          const row: Entry = { meta, updatedAt, current }
          if (!meta.archived && isConversationMetadata(meta) && needsSavedSummary(id)) {
            let summary: Summary
            const key = root + '\0' + id
            const cached = saved.get(key)
            if (cached?.digest === digest) summary = cached.summary
            else {
              saved.delete(key)
              try { summary = describeSavedSession(snapshot(), meta.title) }
              catch { /* An invalid body still has a displayable verified header. */ }
              if (summary && (summary.title?.length ?? 0) <= 8192) {
                saved.set(key, { digest, summary })
                if (saved.size > 512) saved.delete(saved.keys().next().value!)
              }
            }
            row.saved = { summary }
          }
          rows.set(id, row)
        })
      },
      async profile(id: string) {
        const row = rows.get(id)
        if (row && await row.current()) return row
        rows.delete(id)
        return source.profile(id)
      },
      async summary(id: string, fallback: () => Promise<Summary>) {
        const row = rows.get(id)
        if (!row?.saved) return fallback()
        if (await row.current()) return row.saved.summary
        rows.delete(id)
        return undefined
      },
    }
  }
  return { forListing, clear: () => saved.clear() }
}
