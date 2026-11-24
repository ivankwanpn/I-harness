import type { SessionListResult } from "@i-harness/sdk"
import { isConversationMetadata } from "./session-visibility.ts"
import type { SessionCoordinator } from "@i-harness/session-persistence"

/** A failed directory read rejects the entire request. Once enumerated, each
 * row is observed independently; only confirmed rows cross the boundary. */
export async function readCatalogRows<T>(
  source: Pick<SessionCoordinator, "list">,
  prepare: (ids: readonly string[], markPartial: () => void) => (id: string) => Promise<T | undefined>,
  sequential = false,
): Promise<{ rows: T[]; partial: boolean }> {
  let partial = false
  const incomplete = () => { partial = true }
  const ids = await source.list(incomplete)
  const project = prepare(ids, incomplete)
  async function read(id: string) {
    try { return await project(id) }
    catch { incomplete(); return undefined }
  }
  const rows: T[] = []
  if (sequential) {
    for (const id of ids) {
      const row = await read(id)
      if (row !== undefined) rows.push(row)
    }
  } else {
    const projected = await Promise.all(ids.map(read))
    for (const row of projected) if (row !== undefined) rows.push(row)
  }
  return { rows, partial }
}


/** Cold catalog and live server use the same membership, visibility and
 * incomplete-read policy. Only their available summary sources differ. */
export async function readListedSessions(
  source: Pick<SessionCoordinator, "list" | "profile">,
  summaries: (ids: readonly string[]) => (id: string, title: string | undefined) => Promise<{ title?: string; turnCount: number }>,
  sequential = false,
): Promise<SessionListResult> {
  const { rows: sessions, partial } = await readCatalogRows(source, (ids, markPartial) => {
    const summary = summaries(ids)
    return async id => {
      const { meta, updatedAt } = await source.profile(id)
      if (meta.archived || !isConversationMetadata(meta)) return undefined
      const row = { id, ...(updatedAt !== undefined ? { updatedAt } : {}), ...(meta.title !== undefined ? { title: meta.title } : {}) }
      try { return { ...row, ...await summary(id, meta.title) } }
      catch { markPartial(); return row }
    }
  }, sequential)
  return { sessions, ...(partial ? { listingPartial: true } : {}) }
}
