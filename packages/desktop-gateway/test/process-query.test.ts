import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlSessionCoordinator } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { createAgentProcesses } from '../src/agent-processes.ts'
import { createAgentProcessReadRunner } from '../src/agent-process-read.ts'
import { createSessionManagementFence } from '../src/session-management-fence.ts'
import { contextRequestParams } from '../../desktop/src/main/context-requests.ts'
it('closed process query transport retains complete fixed selectors and refuses unknown authority fields', () => {
  const query = { kind: 'desktop/session/processes/job-output', workspaceId: 'w', sessionId: 's', id: 'bash-1', backend: 'shell', instanceId: 'i', sourceId: 'source', mode: 'frames', cursor: { recordOffset: 9, sliceOffset: 1 }, expectedRef: { original: 'comparison-only' } }
  const { kind: _kind, workspaceId: _workspace, ...params } = query
  expect(contextRequestParams(query)).toEqual(params)
  expect(() => contextRequestParams({ ...query, ownerSessionId: 'foreign' })).toThrow(/invalid/)
})
it('malformed frame selectors refuse before any genuine observation or reader page can run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-query-')), coordinator = createJsonlSessionCoordinator(root)
  const service = createSessionService({ workspace: root, coordinator, resultReadScopeFor: async () => undefined })
  let pages = 0, policyCalls = 0
  const runRead = createAgentProcessReadRunner({ coordinator, service, fence: createSessionManagementFence(), isConversation: async () => { policyCalls++; return true }, resultReadScopeFor: async () => undefined, readResultPage: async () => { pages++; return { kind: 'unavailable', reason: 'unavailable' } } })
  const processes = createAgentProcesses(coordinator, service, { runRead })
  try {
    for (const extra of [{ backend: 'other' }, { instanceId: '' }, { sourceId: 1 }, { cursor: null }, { cursor: { recordOffset: 0, sliceOffset: 1 } }, { cursor: { recordOffset: 9, sliceOffset: 0 } }, { expectedRef: {} }, { body: 'forged' }]) {
      expect(await processes.jobOutput('missing', 'bash-1', { backend: 'shell', mode: 'frames', instanceId: 'i', ...extra } as any)).toMatchObject({ kind: 'unavailable' })
    }
    expect(pages).toBe(0); expect(policyCalls).toBe(0); expect(service.hasAssembly('missing')).toBe(false)
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
