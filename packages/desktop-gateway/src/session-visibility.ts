import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import type { SearchHit, SessionQuery } from "@i-harness/session-query"

/** Extra per-session search used when the indexed query has no rows for it
 *  (commit-log sessions are not in the file-backed index yet). */
export type SessionSearchFallback = (sessionId: string, text: string, limit: number) => Promise<SearchHit[]>

// Prior builds stored reviewers as ordinary subagents. Recognize only that
// exact internal request envelope plus its lineage, never an untitled name.
const LEGACY_REVIEW_PREFIX = "An agent requests execution of a tool call. Decide: approve (execute now, never ask the user),\nallow (ask the user first), or deny (never execute)."

export function isConversationMetadata(meta: Readonly<SessionMeta>): boolean {
  return meta.origin !== 'subagent' && meta.origin !== 'approval-review' && !(meta.origin === 'team' && meta.parentSession)
}

export function createConversationVisibility(_coordinator: SessionCoordinator) {
  return async (_id: string, meta: SessionMeta): Promise<boolean> => isConversationMetadata(meta)
}

/** Keep legacy internal review children out of the parent-scoped catalog too. */
export function createSubagentVisibility(coordinator: SessionCoordinator) {
  const legacy = new Map<string, boolean>()
  return async (id: string, meta: SessionMeta): Promise<boolean> => {
    if (meta.origin !== "subagent" || !meta.parentSession) return false
    if (meta.subagentProtocolVersion !== undefined) return meta.subagentProtocolVersion === 1
    if (meta.seedLength !== 0) return true
    if (legacy.has(id)) return legacy.get(id)!
    if (!coordinator.snapshot) throw new Error("Read-only session snapshots are unavailable")
    const snapshot = await coordinator.snapshot(id)
    const first = snapshot.session.events.find((event) => event.type === "user/message")
    if (!first || first.type !== "user/message") return true // do not cache an unfinished old record
    const text = first.text
    const internal = text.startsWith(LEGACY_REVIEW_PREFIX) && text.includes("<request>") && text.includes("<recent_context>") && text.includes("Output STRICT JSON only")
    legacy.set(id, !internal)
    return !internal
  }
}

/** Execution/project ownership still follows public child lineage even though
 * those children have their own parent-scoped navigation surface. */
export function createSessionRuntimeVisibility(coordinator: SessionCoordinator) {
  const child = createSubagentVisibility(coordinator)
  return async (id: string, meta: SessionMeta): Promise<boolean> => meta.origin === "approval-review" ? false : meta.origin === "subagent" ? child(id, meta) : true
}

/** UI search excludes child sessions before applying its result limit, so a
 * busy child transcript cannot crowd the user's conversations out of results. */
export function createConversationQuery(coordinator: SessionCoordinator, query: SessionQuery, fallback?: SessionSearchFallback, lineage: SessionQuery['lineage'] = query.lineage.bind(query)): SessionQuery {
  const visible = createConversationVisibility(coordinator)
  return {
    lineage,
    async search(text, options = {}) {
      const limit = Math.min(options.limit ?? 20, 100)
      const listed = options.sessionId ? [options.sessionId] : await coordinator.list()
      // `subtreeOf` restricts the search to a session and its descendants; the
      // per-session query is then asked without the filter.
      const subtree = options.subtreeOf
        ? new Set([options.subtreeOf, ...(await lineage(options.subtreeOf, { direction: 'descendants', depth: 16 })).map(node => node.sessionId)])
        : undefined
      const ids = subtree ? listed.filter(id => subtree.has(id)) : listed
      const { subtreeOf: _subtreeOf, ...perSession } = options
      const hits = []
      for (const sessionId of ids) {
        const { meta } = await coordinator.profile(sessionId)
        if (!await visible(sessionId, meta)) continue
        const direct = await query.search(text, { ...perSession, sessionId, limit })
        if (direct.length || !fallback) { hits.push(...direct); continue }
        hits.push(...await fallback(sessionId, text, limit))
      }
      return hits.sort((a, b) => a.bm25 - b.bm25).slice(0, limit)
    },
  }
}