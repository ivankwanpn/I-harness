import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createTaskRegistry, SHIPPING_REPORT_POLICY, taskDocKey, type TaskProtocolDocument } from '@i-harness/subagent'
import { createTaskResultRetention } from '../src/lifecycle/task-result-retention.ts'

async function retainedTask() {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'task-reader-'))
  let coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const service = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w' })
  await coordinator.create({ sessionId: 'parent' })
  // A real captured source is what makes current-read authorization apply.
  const results = createTaskResultRetention(service, async () => ({ sourceId: 'source-1', readonly: true }), 'parent')
  const tasks = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, results })
  const task = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 1 }, agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' })
  tasks.claim(task.id)
  // The real spawn path prepares the bound source before the task terminalizes.
  await tasks.prepareResult(task.id)
  tasks.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'capability body', error: '' })
  await tasks.retainResult(task.id)
  const revision = task.result?.kind === 'retained' ? task.result.revision : undefined
  if (!revision) throw new Error('Expected a retained task result')
  await tasks.flushPersistence(); await coordinator.close()
  await service.close()
  return { root, revision }
}

it('distinguishes a real reader from an adapter object that has no ContextOutput service', async () => {
  const { root, revision } = await retainedTask()
  let coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  let service: ReturnType<typeof createContextOutputService> | undefined
  try {
    const document = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    // 1) The real factory WITH its service: durable and readable.
    // A captured source requires the composition's current authorization.
    service = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w', authorizeResult: async (access, metadata) => access.sessionId === metadata.owner.sessionId })
    const readable = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, results: createTaskResultRetention(service, undefined, 'parent') })
    readable.restore(document)
    expect(readable.get('task-1')?.retention).toBe('durable')
    expect(JSON.parse((await readable.readResult('task-1', {})).data.text as string)).toEqual({ resultText: 'capability body', error: '' })
    // 2) The same real factory WITHOUT a service: an adapter exists, but it
    //    cannot read, so durability must not be advertised.
    const unavailable = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, results: createTaskResultRetention(undefined, undefined, 'parent') })
    unavailable.restore(document)
    expect(unavailable.get('task-1')?.retention).toBe('failed')
    expect(unavailable.get('task-1')?.retentionError).toMatch(/reader unavailable/i)
    expect(unavailable.get('task-1')?.result).toMatchObject({ kind: 'retained', revision })
    await expect(unavailable.readResult('task-1', {})).rejects.toThrow(/owner unavailable/i)
    // Re-saving the unsupported reader keeps the current format and descriptor.
    await unavailable.save()
    const resaved = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    expect(resaved.formatVersion).toBe(2)
    expect(resaved.tasks[0]?.result).toMatchObject({ kind: 'retained', revision })
  } finally { await service?.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps the descriptor but refuses a revoked current reader', async () => {
  const { root, revision } = await retainedTask()
  let coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const revoked = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w', authorizeResult: async () => false })
  try {
    const document = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    const tasks = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, results: createTaskResultRetention(revoked, undefined, 'parent') })
    tasks.restore(document)
    // The reader capability itself exists, so the durable claim is honest;
    // the current ACL still refuses the body and nothing is deleted.
    expect(tasks.get('task-1')?.retention).toBe('durable')
    expect(tasks.get('task-1')?.result).toMatchObject({ kind: 'retained', revision })
    await expect(tasks.readResult('task-1', {})).rejects.toThrow()
    expect(tasks.get('task-1')?.result).toMatchObject({ kind: 'retained', revision })
  } finally { await revoked.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
