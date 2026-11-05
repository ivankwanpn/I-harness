import { expect, it } from 'vitest'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createSessionQueryTools } from '@i-harness/session-query'
import type { SessionQuery } from '@i-harness/session-query'
import { createConversationQuery } from '../src/session-visibility.ts'
import { createCommitLogSearchFallback } from '../src/session-search.ts'

const events = [
  { type: 'user/message', text: 'needle in the haystack' },
  { type: 'assistant/message', text: 'nothing here' },
]
const coordinator = {
  list: async () => ['s1'],
  profile: async () => ({ meta: { sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z' }, blank: false }),
  snapshot: async () => ({ session: { events } }),
} as unknown as SessionCoordinator
const emptyIndex: SessionQuery = { search: async () => [], lineage: async () => [] }

it('session_search reaches the commit-log fallback', async () => {
  const conversation = createConversationQuery(coordinator, emptyIndex, createCommitLogSearchFallback(coordinator))
  const tool = createSessionQueryTools(conversation).find(entry => entry.name === 'session_search')!
  const result = await tool.execute({ query: 'needle' }, {}) as { hits: { sessionId: string; snippet: string }[] }
  expect(result.hits).toHaveLength(1)
  expect(result.hits[0]).toMatchObject({ sessionId: 's1' })
  expect(result.hits[0]!.snippet).toContain('needle')
  const missing = await tool.execute({ query: 'absent-token' }, {}) as { hits: unknown[] }
  expect(missing.hits).toEqual([])
})
