import { expect, it } from 'vitest'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createCoordinatorLineage } from '../src/session-search.ts'

const metas: Record<string, { sessionId: string; parentSession?: string; origin?: 'subagent'; delegationDepth?: number; createdAt: string }> = {
  root: { sessionId: 'root', createdAt: '2026-01-01T00:00:00.000Z' },
  sibling: { sessionId: 'sibling', createdAt: '2026-01-01T00:00:30.000Z' },
  child: { sessionId: 'child', parentSession: 'root', origin: 'subagent', delegationDepth: 1, createdAt: '2026-01-01T00:01:00.000Z' },
  grandchild: { sessionId: 'grandchild', parentSession: 'child', origin: 'subagent', delegationDepth: 2, createdAt: '2026-01-01T00:02:00.000Z' },
}
const coordinator = {
  list: async () => Object.keys(metas),
  profile: async (id: string) => { const meta = metas[id]; if (!meta) throw new Error('missing'); return { meta, blank: false } },
} as unknown as SessionCoordinator

it('derives ancestry and descendants from coordinator metadata', async () => {
  const lineage = createCoordinatorLineage(coordinator)
  expect(await lineage('root', { direction: 'children' })).toEqual([
    { sessionId: 'child', parentSession: 'root', delegationDepth: 1, origin: 'subagent', createdAt: '2026-01-01T00:01:00.000Z', hasChildren: true },
  ])
  expect((await lineage('root', { direction: 'descendants', depth: 2 })).map(node => node.sessionId)).toEqual(['child', 'grandchild'])
  expect((await lineage('grandchild', { direction: 'ancestors', depth: 2 })).map(node => node.sessionId)).toEqual(['child', 'root'])
  expect(await lineage('missing', { direction: 'children' })).toEqual([])
  expect(await lineage('missing', { direction: 'ancestors' })).toEqual([])
})
