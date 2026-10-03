import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import type { SessionQuery } from "@i-harness/session-query"

// Prior builds stored reviewers as ordinary subagents. Recognize only that
// exact internal request envelope plus its lineage, never an untitled name.
const LEGACY_REVIEW_PREFIX = "An agent requests execution of a tool call. Decide: approve (execute now, never ask the user),\nallow (ask the user first), or deny (never execute)."

export function createConversationVisibility(_coordinator: SessionCoordinator) {
  return async (_id: string, meta: SessionMeta): Promise<boolean> => meta.origin !== "subagent" && meta.origin !== "approval-review" && !(meta.origin === "team" && meta.parentSession)
}

/** Keep legacy internal review children out of the parent-scoped catalog too. */
export function createSubagentVisibility(coordinator: SessionCoordinator) {
  const legacy = new Map<string, boolean>()
  return async (id: string, meta: SessionMeta): Promise<boolean> => {
    if (meta.origin !== "subagent" || !meta.parentSession) return false
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
export function createConversationQuery(coordinator: SessionCoordinator, query: SessionQuery): SessionQuery {
  const visible = createConversationVisibility(coordinator)
  return {
    lineage: query.lineage.bind(query),
    async search(text, options = {}) {
      const limit = Math.min(options.limit ?? 20, 100)
      const ids = options.sessionId ? [options.sessionId] : await coordinator.list()
      const hits = []
      for (const sessionId of ids) {
        const { meta } = await coordinator.profile(sessionId)
        if (!await visible(sessionId, meta)) continue
        hits.push(...await query.search(text, { ...options, sessionId, limit }))
      }
      return hits.sort((a, b) => a.bm25 - b.bm25).slice(0, limit)
    },
  }
}
