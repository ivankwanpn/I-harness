import { expect, it } from 'vitest'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { SearchHit, SessionQuery } from '@i-harness/session-query'
import { createConversationQuery } from '../src/session-visibility.ts'

const metas: Record<string, { sessionId: string; parentSession?: string; createdAt: string }> = {
  root: { sessionId: 'root', createdAt: '2026-01-01T00:00:00.000Z' },
  child: { sessionId: 'child', parentSession: 'root', createdAt: '2026-01-01T00:01:00.000Z' },
  other: { sessionId: 'other', createdAt: '2026-01-01T00:02:00.000Z' },
}
const coordinator = {
  list: async () => Object.keys(metas),
  profile: async (id: string) => { const meta = metas[id]; if (!meta) throw new Error('missing'); return { meta, blank: false } },
} as unknown as SessionCoordinator
const hit = (sessionId: string): SearchHit => ({ sessionId, seq: 0, eventType: 'user/message', snippet: 'x', bm25: 0 })
const query: SessionQuery = {
  search: async (_text, options = {}) => [hit(options.sessionId!)],
  lineage: async () => [],
}
const lineage: SessionQuery['lineage'] = async (sessionId, options) => {
  if (options.direction !== 'descendants') return []
  return Object.values(metas).filter(meta => meta.parentSession === sessionId).map(meta => ({ sessionId: meta.sessionId, parentSession: meta.parentSession, hasChildren: false }))
}

it('restricts a search to the requested subtree', async () => {
  const conversation = createConversationQuery(coordinator, query, undefined, lineage)
  const all = await conversation.search('x')
  expect(all.map(result => result.sessionId).sort()).toEqual(['child', 'other', 'root'])
  const subtree = await conversation.search('x', { subtreeOf: 'root' })
  expect(subtree.map(result => result.sessionId).sort()).toEqual(['child', 'root'])
})
