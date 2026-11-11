import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../src/task/storage-contract.ts'
import { createTaskRegistry, inspectTaskProjection, reconcileTaskProjection, taskDocKey, type TaskProtocolDocument } from '../src/index.ts'

it('reads legacy diagnostic warnings without treating them as canonical result identity',()=>{
  const original=createTaskRegistry(),task=original.submit({identity:{parentSessionId:'parent'},agentPath:'legacy',description:'legacy',prompt:'work',agent:'general',delivery:'tool'})
  const cold=createTaskRegistry()
  cold.restore({formatVersion:1,tasks:[{...task,projectionWarning:'missing-child-session'}],notifications:[]})
  expect(cold.get(task.id)?.projectionWarning).toBe('missing-child-session')
  expect(cold.annotateProjection(task.id,undefined)).toBe(true)
  expect(cold.get(task.id)?.projectionWarning).toBeUndefined()
  expect(cold.get(task.id)?.status).toBe('accepted')
})

it('reports and annotates a terminal task whose durable child session has no completed turn (D-01)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-projection-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' })
    await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', subagentProtocolVersion: 1, seedLength: 0 })
    const tasks = createTaskRegistry({ coordinator, stateId: 'parent' })
    const task = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 1 }, childSessionId: 'child', agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' })
    tasks.claim(task.id)
    await tasks.flushPersistence()

    // Simulate a projection that claims completion the child never reached.
    const document = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    Object.assign(document.tasks.find(row => row.id === task.id)!, { status: 'completed', outcome: 'completed', timeCompleted: Date.now() })
    await coordinator.putDocumentStrict!(taskDocKey('parent'), document)
    const cold = createTaskRegistry({ coordinator, stateId: 'parent' })
    cold.restore(await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument)

    expect(await inspectTaskProjection(cold, coordinator)).toEqual([
      { kind: 'terminal-without-turn-end', taskId: task.id, childSessionId: 'child' },
    ])
    expect(await reconcileTaskProjection(cold, coordinator)).toHaveLength(1)
    await cold.flushPersistence()
    expect(cold.get(task.id)?.projectionWarning).toBe('terminal-without-turn-end')
    expect((await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument).tasks.find(row => row.id === task.id)?.projectionWarning).toBeUndefined()

    // The child later completes a turn: the next reconcile clears the warning
    // without touching status/outcome.
    await coordinator.append('child', [{ type: 'turn/start' }, { type: 'assistant/message', text: 'done' }, { type: 'turn/end' }])
    expect(await reconcileTaskProjection(cold, coordinator)).toEqual([])
    await cold.flushPersistence()
    const row = (await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument).tasks.find(item => item.id === task.id)!
    expect(row.projectionWarning).toBeUndefined()
    expect(row.outcome).toBe('completed')
  } finally {
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('reports a task whose child session is missing from storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-projection-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'parent' })
    const tasks = createTaskRegistry({ coordinator, stateId: 'parent' })
    const task = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 2 }, childSessionId: 'missing', agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' })
    tasks.claim(task.id)
    await tasks.flushPersistence()
    const cold = createTaskRegistry({ coordinator, stateId: 'parent' })
    cold.restore(await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument)
    expect(await inspectTaskProjection(cold, coordinator)).toEqual([
      { kind: 'missing-child-session', taskId: task.id, childSessionId: 'missing' },
    ])
  } finally {
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})
