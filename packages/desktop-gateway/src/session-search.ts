import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { SearchHit } from '@i-harness/session-query'
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
    if (!needle) return []
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
