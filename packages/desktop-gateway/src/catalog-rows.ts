import type { SessionListResult } from "@i-harness/sdk"
import { isConversationMetadata } from "./session-visibility.ts"
import type { SessionCatalogHeader, SessionCoordinator } from "@i-harness/session-persistence"

/** A failed directory read rejects the entire request. Once enumerated, each
 * row is observed independently; only confirmed rows cross the boundary. */
export async function readCatalogRows<T>(
  source: Pick<SessionCoordinator, "list">,
  prepare: (ids: readonly string[], markPartial: () => void) => (id: string) => Promise<T | undefined>,
  sequential = false,
  onlyId?: string,
): Promise<{ rows: T[]; partial: boolean }> {
  let partial = false
  const incomplete = () => { partial = true }
  const listed = onlyId === undefined ? await source.list(incomplete) : await source.list(incomplete, onlyId)
  // Embedded coordinators may implement only the original unfiltered list.
  const ids = onlyId === undefined ? listed : listed.filter(id => id === onlyId)
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
  summaries: (ids: readonly string[]) => (id: string, header: SessionCatalogHeader) => Promise<{ title?: string; turnCount: number } | undefined>,
  sequential = false,
): Promise<SessionListResult> {
  const { rows: sessions, partial } = await readCatalogRows(source, (ids, markPartial) => {
    const summary = summaries(ids)
    const visibleRow = async (id: string) => {
      const { meta, updatedAt } = await source.profile(id)
      if (meta.archived || !isConversationMetadata(meta)) return undefined
      return {
        meta,
        row: {
          id,
          ...(updatedAt !== undefined ? { updatedAt } : {}),
          ...(meta.title !== undefined ? { title: meta.title } : {}),
          ...(meta.origin === "fork" && meta.parentSession ? { forkParentId: meta.parentSession } : {}),
        },
      }
    }
    return async id => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const profile = await visibleRow(id)
        if (!profile) return undefined
        try {
          const details = await summary(id, profile.meta)
          if (details) return { ...profile.row, ...details }
        } catch { break } // A damaged body need not be replayed twice.
      }
      // A damaged or continuously changing but still visible conversation keeps its
      // newly observed header. Its title override and turn count are unknown.
      const latest = await visibleRow(id)
      if (latest) markPartial()
      return latest?.row
    }
  }, sequential)
  return { sessions, ...(partial ? { listingPartial: true } : {}) }
}
