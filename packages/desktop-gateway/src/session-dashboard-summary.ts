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
  const entries = new Map<string, { revision: string; headerTitle: string | undefined; summary: Promise<Summary> }>()
  return async (root: string, id: string, headerTitle: string | undefined, load: () => Promise<SavedSession>): Promise<Summary> => {
    const path = join(root, id + ".jsonl")
    const revision = await fileRevision(path)
    if (!revision) return describeSession(await load(), headerTitle)
    const previous = entries.get(path)
    if (previous?.revision === revision && previous.headerTitle === headerTitle) return previous.summary
    entries.delete(path)
    const entry = { revision, headerTitle, summary: load().then(session => describeSession(session, headerTitle)) }
    entries.set(path, entry)
    if (entries.size > 512) entries.delete(entries.keys().next().value!)
    try {
      const summary = await entry.summary
      if (await fileRevision(path) !== revision && entries.get(path) === entry) entries.delete(path)
      return summary
    } catch (error) {
      if (entries.get(path) === entry) entries.delete(path)
      throw error
    }
  }
}
