import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createResultCapture } from '../../output-retention/src/index.ts'
import { createTaskRegistry, createNotificationDrain, SHIPPING_REPORT_POLICY, taskDocKey, type TaskProtocolDocument, type TaskResultStore } from '../src/index.ts'

it.each([false, true])('qualifies a cold version2 task only through its original committed F1 result (committed=%s)', async committed => {
  const root = await mkdtemp(join(tmpdir(), 'task-result-cold-'))
  let coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  let store = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w' })
  let captures = 0, admissions = 0, wakes = 0
  const results: TaskResultStore = {
    capture(task, body, revision, execution) {
      captures++
      const scope = store.registerResultScope({ operationId: revision, sessionId: 'parent', callId: task.id, documentId: 'task-parent' }, () => true)
      return createResultCapture(body, execution!, { forceArtifact: true, openArtifact: () => store.beginResult(scope, 'json-utf8-v1') })
    }, read: (_task, ref, args) => store.readResult({ sessionId: 'parent' }, { ref, ...args }),
  }
  try {
    await coordinator.create({ sessionId: 'parent' })
    const document = await coordinator.openManagedDocument('parent')
    const tasks = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, results })
    const task = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 1 }, agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' })
    tasks.claim(task.id)
    tasks.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'retained original bytes', error: '' })
    await tasks.retainResult(task.id)
    if (task.result?.kind !== 'retained') throw new Error('Expected retained source fixture')
    if (committed) {
      const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
      committedFactSeqs(await source.delivery.record({ type: 'subagent/end', version: 1, taskId: task.id, outcome: 'completed', resultRevision: task.result.revision, envelope: task.result.envelope, resultText: task.resultText, error: task.error }))
      await source.close(); action.finish()
    }
    await tasks.flushPersistence(); await coordinator.close(); await store.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    store = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w' })
    const reopened = await coordinator.openManagedDocument('parent')
    const cold = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, results })
    cold.restore(await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument)
    await (cold as any).qualifyRestoredResults?.()
    expect(cold.get(task.id)?.outcome).toBe(committed ? 'completed' : 'recovery-required')
    const drain = createNotificationDrain({ tasks: cold, reportPolicy: SHIPPING_REPORT_POLICY, admit: { admit: async () => { admissions++ }, wake() { wakes++ } } })
    await drain.drain()
    expect(admissions).toBe(committed ? 1 : 0); expect(wakes).toBe(committed ? 1 : 0)
    const page = await cold.readResult(task.id, {})
    expect(JSON.parse(page.data.text)).toEqual({ resultText: 'retained original bytes', error: '' })
    expect(reopened.view.events.filter(event => event.type === 'subagent/end')).toHaveLength(committed ? 1 : 0)
    expect(captures).toBe(1)
    // The first cold reader persists its genuine derived publication
    // descriptor; the next cold restore must accept its own current-format
    // document (the owner used to reject the outcome field it wrote itself).
    const beforeAgain = reopened.view.events.length
    await cold.save()
    const savedAgain = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    expect(savedAgain.formatVersion).toBe(2)
    expect(savedAgain.tasks[0]?.publication).toBe(committed ? 'committed' : 'unqualified')
    // savedObservation keeps the ORIGINAL observation in both cases; only the
    // derived status/outcome differ.
    expect(savedAgain.tasks[0]?.savedObservation).toMatchObject({ status: 'completed', outcome: 'completed' })
    const originalRef = task.result.envelope.retention.kind === 'artifact' ? task.result.envelope.retention.ref : undefined
    expect(originalRef).toBeDefined()
    const nextCold = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, results })
    expect(() => nextCold.restore(savedAgain)).not.toThrow()
    const reread = nextCold.get(task.id)?.result
    expect(reread).toMatchObject({ kind: 'retained', revision: task.result.revision })
    expect(reread?.kind === 'retained' ? reread.envelope.retention : undefined)
      .toMatchObject({ kind: 'artifact', ref: { id: originalRef!.id, revision: originalRef!.revision } })
    expect(reopened.view.events.length).toBe(beforeAgain)
    expect(captures).toBe(1)
  } finally { await coordinator.close(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
