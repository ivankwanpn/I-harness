import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
import { createDurableSessionLoader, createSessionService } from '@i-harness/session-executor'
import { createAgentProcesses } from '../src/agent-processes.ts'
import { createAgentProcessReadRunner } from '../src/agent-process-read.ts'
import { createSessionManagementFence } from '../src/session-management-fence.ts'
import { contextRequestParams } from '../../desktop/src/main/context-requests.ts'
import { buildSavedProcessIndex } from '../src/saved-process-index.ts'

it('reads a live native job by exact instance and source before its terminal is committed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-live-instance-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, undefined, taskDocumentStorageContract)
  const service = createSessionService({ workspace: root, coordinator })
  const nativeJob = { version: 1 as const, jobId: 'bash-1', instanceId: 'current', ownerSessionId: 's', sourceId: 'process:original' }
  const processes = createAgentProcesses(coordinator, service, { runRead: (_id, work) => work({
    index: buildSavedProcessIndex([], 's', 14),
    session: { events: [], formatVersion: 14 }, document: undefined,
    managedProcesses: () => ({ background: [
      { id: 'bash-1', kind: 'shell', status: 'running', output: 'current output', outputTruncated: false, ownerSessionId: 's', nativeJob },
    ], tasks: () => [] }),
    select() {}, selectTerminal() {}, assertCurrent() {}, async checkpoint() {},
    async page() { throw new Error('An unsettled job has no retained page') },
  }) })
  try {
    const query = { backend: 'shell' as const, instanceId: nativeJob.instanceId, sourceId: nativeJob.sourceId }
    expect(await processes.jobOutput('s', 'bash-1', query)).toMatchObject({ text: 'current output', live: true, ownerSessionId: 's' })
    await expect(processes.jobOutput('s', 'bash-1', { ...query, instanceId: 'previous' })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(processes.jobOutput('s', 'bash-1', { ...query, sourceId: 'process:previous' })).rejects.toMatchObject({ code: 'stale-source' })
  } finally {
    await service.close()
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('closed process query transport retains complete fixed selectors and refuses unknown authority fields', () => {
  const query = { kind: 'desktop/session/processes/job-output', workspaceId: 'w', sessionId: 's', id: 'bash-1', backend: 'shell', instanceId: 'i', sourceId: 'source', mode: 'frames', cursor: { recordOffset: 9, sliceOffset: 1 }, expectedRef: { original: 'comparison-only' } }
  const { kind: _kind, workspaceId: _workspace, ...params } = query
  expect(contextRequestParams(query)).toEqual(params)
  expect(() => contextRequestParams({ ...query, ownerSessionId: 'foreign' })).toThrow(/invalid/)
})
it('malformed frame selectors refuse before any genuine observation or reader page can run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-query-')), coordinator = createJsonlTaskTransitionCoordinator(root, undefined, taskDocumentStorageContract)
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

it('joins only the existing compatibility mount for the selected process read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-warm-owner-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const fence = createSessionManagementFence()
  const service = createSessionService({
    workspace: root,
    coordinator,
    sessionFor: createDurableSessionLoader(coordinator),
    modelPolicy: 'test-mock',
    sessionOperation: fence,
    async extensionsFor(id) {
      if (id === 'warming') { entered.resolve(); await release.promise }
      return { options: {} }
    },
  })
  const runRead = createAgentProcessReadRunner({
    coordinator, service, fence, isConversation: async () => true, resultReadScopeFor: async () => undefined,
  })
  const processes = createAgentProcesses(coordinator, service, { runRead })
  try {
    await coordinator.create({ sessionId: 'warming' })
    await coordinator.create({ sessionId: 'cold' })
    const warm = service.assemblyFor('warming')
    void warm.catch(() => {})
    await entered.promise
    expect(service.liveAssembly('warming')).toBeUndefined()
    const reading = processes.read('warming')
    void reading.catch(() => {})
    expect(await processes.read('cold')).toMatchObject({ sessionId: 'cold', live: false })
    expect(service.hasAssembly('cold')).toBe(false)
    release.resolve()
    expect(await warm).toBe(service.liveAssembly('warming'))
    expect(await reading).toMatchObject({ sessionId: 'warming', live: true, jobs: [], terminals: [] })
  } finally {
    release.resolve()
    try { await service.close() }
    finally { try { await coordinator.close() } finally { await rm(root, { recursive: true, force: true }) } }
  }
})
