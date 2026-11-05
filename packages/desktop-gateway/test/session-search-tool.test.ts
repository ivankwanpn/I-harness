import { expect, it } from 'vitest'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createSessionQueryTools } from '@i-harness/session-query'
import type { SessionQuery } from '@i-harness/session-query'
import { createConversationQuery } from '../src/session-visibility.ts'
import { createCommitLogSearchFallback, createCoordinatorLineage } from '../src/session-search.ts'

const longText = 'x'.repeat(200) + ' needle ' + 'y'.repeat(200)
const sessions: Record<string, { meta: { sessionId: string; parentSession?: string; createdAt: string }; events: { type: string; text?: string }[] }> = {
  root: { meta: { sessionId: 'root', createdAt: '2026-01-01T00:00:00.000Z' }, events: [] },
  child: { meta: { sessionId: 'child', parentSession: 'root', createdAt: '2026-01-01T00:01:00.000Z' }, events: [{ type: 'user/message', text: 'needle in the haystack' }] },
  long: { meta: { sessionId: 'long', createdAt: '2026-01-01T00:02:00.000Z' }, events: [{ type: 'user/message', text: longText }] },
}
const coordinator = {
  list: async () => Object.keys(sessions),
  profile: async (id: string) => { const value = sessions[id]; if (!value) throw new Error('missing'); return { meta: value.meta, blank: false } },
  snapshot: async (id: string) => { const value = sessions[id]; if (!value) throw new Error('missing'); return { session: { events: value.events } } },
} as unknown as SessionCoordinator
const emptyIndex: SessionQuery = { search: async () => [], lineage: async () => [] }
const build = () => createSessionQueryTools(createConversationQuery(coordinator, emptyIndex, createCommitLogSearchFallback(coordinator), createCoordinatorLineage(coordinator)))

it('session_search reaches the commit-log fallback', async () => {
  const tool = build().find(entry => entry.name === 'session_search')!
  const result = await tool.execute({ query: 'needle', session_id: 'child' }, {}) as { hits: { sessionId: string; snippet: string }[] }
  expect(result.hits).toHaveLength(1)
  expect(result.hits[0]).toMatchObject({ sessionId: 'child' })
  expect(result.hits[0]!.snippet).toContain('needle')
  const missing = await tool.execute({ query: 'absent-token' }, {}) as { hits: unknown[] }
  expect(missing.hits).toEqual([])
})

it('clamps search limits', async () => {
  const tool = build().find(entry => entry.name === 'session_search')!
  expect((await tool.execute({ query: 'needle', limit: 0 }, {}) as { hits: unknown[] }).hits).toEqual([])
  expect((await tool.execute({ query: 'needle', limit: -5 }, {}) as { hits: unknown[] }).hits).toEqual([])
  expect((await tool.execute({ query: 'needle', session_id: 'child', limit: 1000 }, {}) as { hits: unknown[] }).hits).toHaveLength(1)
})

it('truncates a snippet around the match', async () => {
  const tool = build().find(entry => entry.name === 'session_search')!
  const result = await tool.execute({ query: 'needle', session_id: 'long' }, {}) as { hits: { snippet: string }[] }
  const snippet = result.hits[0]!.snippet
  expect(snippet.length).toBeLessThan(longText.length)
  expect(snippet.startsWith('…')).toBe(true)
  expect(snippet.endsWith('…')).toBe(true)
  expect(snippet).toContain('needle')
})

it('lineage is answered from coordinator metadata', async () => {
  const tool = build().find(entry => entry.name === 'lineage')!
  const ancestors = await tool.execute({ session_id: 'child', direction: 'ancestors' }, {}) as { nodes: { sessionId: string }[] }
  expect(ancestors.nodes.map(node => node.sessionId)).toEqual(['root'])
  const children = await tool.execute({ session_id: 'root', direction: 'children' }, {}) as { nodes: { sessionId: string }[] }
  expect(children.nodes.map(node => node.sessionId)).toEqual(['child'])
})