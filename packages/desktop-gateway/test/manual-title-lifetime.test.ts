import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createJsonlCommitCoordinator } from '@i-harness/session-persistence-jsonl/internal/commit-coordinator'
import { asSessionCoordinator } from '@i-harness/session-persistence/internal/commit-facade'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnedMetadataFold } from '../../session-executor/src/lifecycle/owned-metadata-fold.ts'
import { createSessionService } from '../../session-executor/src/service.ts'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { originalManagedExecutionFor } from '../../session-executor/src/host-managed-execution.ts'
import { deriveSessionTitle } from '@i-harness/core-session'
import { createSessionManagement } from '../src/session-management.ts'

it.each(['jsonl', 'commit-log'] as const)('renames without retiring held work, queued input, or children on %s', async store => {
  const root = await mkdtemp(join(tmpdir(), 'ih-manual-title-lifetime-'))
  const options = { lock: { enabled: true, lockRoot: root }, originalExecutionFoldFactory: createOwnedMetadataFold }
  const coordinator = store === 'jsonl'
    ? composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), options, taskDocumentStorageContract)
    : asSessionCoordinator(createJsonlCommitCoordinator(root, options), { taskDocument: { validator: taskDocumentStorageContract, empty: taskDocumentStorageContract.empty } })
  await coordinator.create({ sessionId: 'parent' })
  await coordinator.create({ sessionId: 'child', origin: 'subagent', parentSession: 'parent', seedLength: 0 })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let requests = 0
  const service = createSessionService({ workspace: root, coordinator, managedRuntime: { systemPrompt: 'system', tools: [] }, contextWindow: 4096, maxOutputTokens: 128,
    model: controlledModel(async function* () { requests++; if (requests === 1) { entered.resolve(); await release.promise }; yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' } }) })
  const turn = service.submit('parent', 'held', new AbortController().signal)
  try {
    await entered.promise
    const original = originalManagedExecutionFor(service, 'parent')!
    const input = await service.managedInputFor!('parent')
    await input!.inbox.admit({ inputId: 'pending', text: 'later', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
    const management = createSessionManagement(coordinator, service, async () => true)
    await management.mutate('parent', 'rename', 'Manual while busy')
    expect(originalManagedExecutionFor(service, 'parent')!.identity).toBe(original.identity)
    expect(service.queueState('parent')).toMatchObject({ running: true, queued: 1 })
    expect((await coordinator.profile('child')).meta.parentSession).toBe('parent')
    release.resolve(); await turn
    await service.submit('parent', 'later', new AbortController().signal, { admittedInputId: 'pending' })
    expect(requests).toBe(2)
    expect(deriveSessionTitle((await coordinator.snapshot!('parent')).session)).toMatchObject({ title: 'Manual while busy', source: 'user' })
    await input!.inbox.admit({ inputId: 'archived-pending', text: 'resume after restore', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
    const pendingBefore = original.observe().inbox.pending()
    await management.mutate('parent', 'archive')
    expect((await coordinator.profile('parent')).meta.archived).toBe(true)
    expect(original.observe().inbox.pending()).toEqual(pendingBefore)
    expect(originalManagedExecutionFor(service, 'parent')!.identity).toBe(original.identity)
    await management.mutate('parent', 'restore')
    expect(original.observe().inbox.pending()).toEqual(pendingBefore)
    await service.submit('parent', 'resume after restore', new AbortController().signal, { admittedInputId: 'archived-pending' })
    expect(requests).toBe(3)
    expect((await coordinator.profile('child')).meta.parentSession).toBe('parent')
  } finally { release.resolve(); await turn.catch(() => {}); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 60_000)
