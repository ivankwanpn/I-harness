import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { LineageNode, SearchHit, SessionQuery } from '@i-harness/session-query'
import type { SessionSearchFallback } from './session-visibility.ts'

const messageText = (event: { type: string; text?: unknown; output?: unknown; args?: unknown }): string | undefined => {
  if (event.type === 'user/message' || event.type === 'assistant/message') return typeof event.text === 'string' ? event.text : undefined
  if (event.type === 'tool/result') return typeof event.output === 'string' ? event.output : event.output === undefined ? undefined : JSON.stringify(event.output)
  if (event.type === 'tool/call') return event.args === undefined ? undefined : JSON.stringify(event.args)
  return undefined
}

const snippetAround = (body: string, at: number, length: number): string => {
  const start = Math.max(0, at - 40), end = Math.min(body.length, at + length + 80)
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
}

/** Substring search over a commit-log session's events. Used only when the
 *  file-backed index returns nothing for the session. */
export function createCommitLogSearchFallback(coordinator: SessionCoordinator): SessionSearchFallback {
  return async (sessionId, text, limit) => {
    const needle = text.trim().toLowerCase()
    if (!needle || limit <= 0) return []
    let events: readonly { type: string; seq?: number; text?: unknown; output?: unknown; args?: unknown }[]
    try { events = (await coordinator.snapshot!(sessionId)).session.events } catch { return [] }
    const hits: SearchHit[] = []
    for (const [index, event] of events.entries()) {
      const body = messageText(event)
      if (!body) continue
      const at = body.toLowerCase().indexOf(needle)
      if (at < 0) continue
      hits.push({ sessionId, seq: typeof event.seq === 'number' ? event.seq : index, eventType: event.type as SearchHit['eventType'], snippet: snippetAround(body, at, needle.length), bm25: 0 })
      if (hits.length >= limit) break
    }
    return hits
  }
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