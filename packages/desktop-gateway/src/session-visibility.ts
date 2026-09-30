import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"

// Prior builds stored reviewers as ordinary subagents. Recognize only that
// exact internal request envelope plus its lineage, never an untitled name.
const LEGACY_REVIEW_PREFIX = "An agent requests execution of a tool call. Decide: approve (execute now, never ask the user),\nallow (ask the user first), or deny (never execute)."

export function createConversationVisibility(coordinator: SessionCoordinator) {
  const legacy = new Map<string, boolean>()
  return async (id: string, meta: SessionMeta): Promise<boolean> => {
    if (meta.origin === "approval-review") return false
    if (meta.origin !== "subagent" || !meta.parentSession || meta.seedLength !== 0) return true
    if (legacy.has(id)) return legacy.get(id)!
    const snapshot = await (coordinator.snapshot?.(id) ?? coordinator.load(id))
    const first = snapshot.session.events.find((event) => event.type === "user/message")
    if (!first || first.type !== "user/message") return true // do not cache an unfinished old record
    const text = first.text
    const internal = text.startsWith(LEGACY_REVIEW_PREFIX) && text.includes("<request>") && text.includes("<recent_context>") && text.includes("Output STRICT JSON only")
    legacy.set(id, !internal)
    return !internal
  }
}
