import { stat } from "node:fs/promises"
import { join } from "node:path"
import { deriveSessionTitle } from "@i-harness/core-session"
import type { SessionCatalogHeader, SessionCoordinator } from '@i-harness/session-persistence'
import { isConversationMetadata } from "./session-visibility.ts"

type SavedSession = Parameters<typeof deriveSessionTitle>[0]
type Summary = { title?: string; turnCount: number }

export function describeSession(session: SavedSession, headerTitle: string | undefined): Summary {
  const committed = deriveSessionTitle(session)
  return {
    title: committed?.source === "user" ? committed.title : headerTitle ?? committed?.title,
    turnCount: session.events.filter(event => event.type === "turn/end").length,
  }
}

/** A writer may archive or replace this session after its profile was read. */
export function describeSavedSession(session: SavedSession | undefined, headerTitle: string | undefined): Summary | undefined {
  if (!session) return undefined
  const header = session.header
  if (header && (('archived' in header && header.archived === true) || !isConversationMetadata(header))) return undefined
  return describeSession(session, headerTitle)
}

function catalogIdentity(header: SessionCatalogHeader): string {
  return JSON.stringify([header.sessionId, header.createdAt, header.title, header.parentSession, header.origin, header.archived === true, header.forkPublication])
}

export async function loadCatalogSession(source: Pick<SessionCoordinator, 'snapshot' | 'profile'> & Partial<Pick<SessionCoordinator, 'load'>>, id: string, header: SessionCatalogHeader): Promise<SavedSession | undefined> {
  const snapshot = source.snapshot ? await source.snapshot(id, { includeCatalogHeader: true }) : undefined
  const session = snapshot?.session ?? (await source.load!(id)).session
  // A legacy coordinator or a resident document may only supply a detached
  // Session. Reconfirm the row after that read before using its summary.
  const observed = snapshot?.catalogHeader ?? (await source.profile(id)).meta
  if (observed.sessionId !== id || catalogIdentity(observed) !== catalogIdentity(header)) return undefined
  return session
}

async function fileRevision(path: string): Promise<string | undefined> {
  const value = await stat(path, { bigint: true }).catch(() => undefined)
  return value ? [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":") : undefined
}

/** Cache display summaries only. Callers still read current visibility from
 * the coordinator; a changed file always goes through the original reader. */
export function createJsonlDashboardSummaryCache() {
  type Entry = { revision: string; profileKey: string; summary: Promise<Summary | undefined> }
  // The display index lives with its catalog owner. It retains one summary
  // per listed session, never event histories. Reconcile membership on each
  // enumeration rather than evicting records ahead of the next scan.
  const roots = new Map<string, Map<string, Entry>>()
  function forListing(root: string, ids: readonly string[]) {
    const entries = roots.get(root) ?? new Map<string, Entry>()
    roots.set(root, entries)
    const currentIds = new Set(ids)
    for (const id of entries.keys()) if (!currentIds.has(id)) entries.delete(id)
    return async (id: string, header: SessionCatalogHeader, load: () => Promise<SavedSession | undefined>): Promise<Summary | undefined> => {
      const path = join(root, id + ".jsonl")
      const revision = await fileRevision(path)
      if (!revision) return describeSavedSession(await load(), header.title)
      const profileKey = catalogIdentity(header)
      const previous = entries.get(id)
      if (previous?.revision === revision && previous.profileKey === profileKey) return previous.summary
      // All concurrent readers join the same checked result. An archive or
      // header replacement during the snapshot also invalidates its profile.
      const entry = { revision, profileKey, summary: load().then(async session =>
        await fileRevision(path) === revision ? describeSavedSession(session, header.title) : undefined) }
      entries.set(id, entry)
      try {
        const summary = await entry.summary
        if (!summary && entries.get(id) === entry) entries.delete(id)
        return summary
      } catch (error) {
        if (entries.get(id) === entry) entries.delete(id)
        throw error
      }
    }
  }
  return { forListing, clear: () => roots.clear() }
}
