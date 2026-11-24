import { deriveSearchText } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { SEARCH_PAGE_SIZE, searchConversationDocuments, type ConversationSearch, type LineageNode, type SessionQuery } from '@i-harness/session-query'

export function createCommitLogConversationSearch(coordinator: SessionCoordinator): ConversationSearch {
  return (text, ids, limit) => searchConversationDocuments(text, ids, limit, async function* (sessionId) {
    if (!coordinator.snapshot) throw new Error("Session snapshots are unavailable")
    const { events } = (await coordinator.snapshot(sessionId)).session
    for (let start = 0; start < events.length; start += SEARCH_PAGE_SIZE) {
      yield events.slice(start, start + SEARCH_PAGE_SIZE).map((event, i) => ({
        seq: event.seq ?? start + i, eventType: event.type, text: deriveSearchText(event),
      }))
    }
  })
}

/** Lineage from the coordinator's metadata (commit-log sessions are not in the
 *  file-backed index); children are discovered by scanning profiles. */
export function createCoordinatorLineage(coordinator: SessionCoordinator): SessionQuery['lineage'] {
  const metaOf = async (id: string) => {
    try { return (await coordinator.profile(id)).meta } catch { return undefined }
  }
  const childrenOf = async (id: string): Promise<string[]> => {
    const children: string[] = []
    for (const candidate of await coordinator.list()) {
      const meta = await metaOf(candidate)
      if (meta?.parentSession === id) children.push(candidate)
    }
    return children
  }
  const node = async (id: string): Promise<LineageNode | undefined> => {
    const meta = await metaOf(id)
    if (!meta) return undefined
    return { sessionId: id, ...(meta.parentSession === undefined ? {} : { parentSession: meta.parentSession }), ...(meta.delegationDepth === undefined ? {} : { delegationDepth: meta.delegationDepth }), ...(meta.origin === undefined ? {} : { origin: meta.origin }), ...(meta.seedLength === undefined ? {} : { seedLength: meta.seedLength }), ...(meta.createdAt === undefined ? {} : { createdAt: meta.createdAt }), hasChildren: (await childrenOf(id)).length > 0 }
  }
  return async (sessionId, options) => {
    const maxDepth = Math.max(1, Math.min(options.depth ?? 1, 16))
    const out: LineageNode[] = []
    if (options.direction === 'ancestors') {
      let cursor = (await metaOf(sessionId))?.parentSession, level = 0
      while (cursor && level < maxDepth) {
        const value = await node(cursor)
        if (!value) break
        out.push(value)
        cursor = value.parentSession
        level++
      }
      return out
    }
    const queue = (await childrenOf(sessionId)).map(id => ({ id, level: 1 }))
    while (queue.length) {
      const { id, level } = queue.shift()!
      const value = await node(id)
      if (!value) continue
      out.push(value)
      if (level >= maxDepth) continue
      for (const child of await childrenOf(id)) queue.push({ id: child, level: level + 1 })
    }
    return out
  }
}