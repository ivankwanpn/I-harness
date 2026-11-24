import { stat } from "node:fs/promises"
import { join } from "node:path"
import { deriveSessionTitle } from "@i-harness/core-session"

type SavedSession = Parameters<typeof deriveSessionTitle>[0]
type Summary = { title?: string; turnCount: number }

export function describeSession(session: SavedSession, headerTitle: string | undefined): Summary {
  const committed = deriveSessionTitle(session)
  return {
    title: committed?.source === "user" ? committed.title : headerTitle ?? committed?.title,
    turnCount: session.events.filter(event => event.type === "turn/end").length,
  }
}

async function fileRevision(path: string): Promise<string | undefined> {
  const value = await stat(path, { bigint: true }).catch(() => undefined)
  return value ? [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":") : undefined
}

/** Cache display summaries only. Callers still read current visibility from
 * the coordinator; a changed file always goes through the original reader. */
export function createJsonlDashboardSummaryCache() {
  type Entry = { revision: string; headerTitle: string | undefined; summary: Promise<Summary> }
  // The display index lives with its catalog owner. It retains one summary
  // per listed session, never event histories. Reconcile membership on each
  // enumeration rather than evicting records ahead of the next scan.
  const roots = new Map<string, Map<string, Entry>>()
  function forListing(root: string, ids: readonly string[]) {
    const entries = roots.get(root) ?? new Map<string, Entry>()
    roots.set(root, entries)
    const currentIds = new Set(ids)
    for (const id of entries.keys()) if (!currentIds.has(id)) entries.delete(id)
    return async (id: string, headerTitle: string | undefined, load: () => Promise<SavedSession>): Promise<Summary> => {
      const path = join(root, id + ".jsonl")
      const revision = await fileRevision(path)
      if (!revision) return describeSession(await load(), headerTitle)
      const previous = entries.get(id)
      if (previous?.revision === revision && previous.headerTitle === headerTitle) return previous.summary
      const entry = { revision, headerTitle, summary: load().then(session => describeSession(session, headerTitle)) }
      entries.set(id, entry)
      try {
        const summary = await entry.summary
        if (await fileRevision(path) !== revision && entries.get(id) === entry) entries.delete(id)
        return summary
      } catch (error) {
        if (entries.get(id) === entry) entries.delete(id)
        throw error
      }
    }
  }
  return { forListing, clear: () => roots.clear() }
}
