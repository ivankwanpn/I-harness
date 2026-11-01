import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../src/task/storage-contract.ts'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createResultCapture } from '../../output-retention/src/index.ts'
import { createTaskRegistry, classifyRestoredTasks, createNotificationDrain, SHIPPING_REPORT_POLICY, taskDocKey, type TaskProtocolDocument, type TaskResultStore } from '../src/index.ts'

// Catches routing a current unfinished/pending observation through the legacy
// classifier, or treating a successful auxiliary save as a complete body.
it.each(['accepted', 'running-complete', 'running-interrupted', 'running-missing', 'pending', 'running-pending'] as const)('preserves current %s across real cold restore, drain and save/reopen/save without new terminal work', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'current-unfinished-'))
  let coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  let store = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w' })
  let captures = 0, callbacks = 0, admissions = 0, wakes = 0
  const results: TaskResultStore = {
    available: () => true,
    capture(task, body, revision, execution) {
      captures++
      const scope = store.registerResultScope({ operationId: revision, sessionId: 'parent', callId: task.id, documentId: 'task-parent' }, () => true)
      return createResultCapture(body, execution!, { forceArtifact: true, openArtifact: () => store.beginResult(scope, 'json-utf8-v1') })
    }, read: (_task, ref, args) => store.readResult({ sessionId: 'parent' }, { ref, ...args }),
  }
  const options = () => ({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, results, onTerminalized() { callbacks++ } })
  try {
    await coordinator.create({ sessionId: 'parent' })
    await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', subagentProtocolVersion: 1, seedLength: 0 })
    await coordinator.append('child', [{ type: 'turn/start' }, { type: 'assistant/message', text: 'child-only text is history' }, ...(kind === 'running-interrupted' ? [] : [{ type: 'turn/end' as const }])])
    const tasks = createTaskRegistry(options())
    const task = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 1 }, childSessionId: kind === 'running-missing' ? 'missing' : 'child', agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' })
    if (kind !== 'accepted') tasks.claim(task.id)
    await tasks.flushPersistence()
    await expect(tasks.retainResult(task.id)).rejects.toThrow(/body.*(unavailable|incomplete)/i)
    expect(task.retention).not.toBe('durable')
    const original = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    if (kind === 'pending' || kind === 'running-pending') {
      // Durable pending descriptor is the original revision whose source was
      // lost. It must not be replaced by a new capture from child text.
      Object.assign(original.tasks[0]!, { status: 'completed', outcome: 'completed', result: { version: 1, kind: 'pending', revision: 'original-pending' }, timeCompleted: 123 })
      if (kind === 'running-pending') { original.tasks[0]!.status = 'running'; delete original.tasks[0]!.outcome; delete original.tasks[0]!.timeCompleted }
      original.notifications.push({ id: 'notif-1', submissionId: task.id, parentSessionId: 'parent', messageId: 'original-message', state: 'completed', description: 'a', text: 'original notification', status: 'pending', attempts: 0, timeCreated: 123 })
      await coordinator.putDocumentStrict!(taskDocKey('parent'), original)
    }
    const observed = structuredClone(original.tasks[0]!)
    await coordinator.close(); await store.close()
    coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
    store = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w' })
    for (let restart = 0; restart < 2; restart++) {
      if (restart > 0) {
        await coordinator.close(); await store.close()
        coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
        store = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w' })
      }
      const cold = createTaskRegistry(options())
      cold.restore(await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument)
      await cold.qualifyRestoredResults()
      expect(await classifyRestoredTasks(cold, coordinator)).toBe(0)
      const row = cold.get(task.id)!
      expect(row).toMatchObject({ status: 'recovery-required', outcome: 'recovery-required', publication: 'unqualified', timeCreated: observed.timeCreated })
      expect(row.savedObservation).toEqual({ status: observed.status, ...(observed.outcome === undefined ? {} : { outcome: observed.outcome }) })
      expect(Object.hasOwn(row.savedObservation!, 'outcome')).toBe(observed.outcome !== undefined)
      expect(row.timeStarted).toBe(observed.timeStarted); expect(row.timeCompleted).toBe(observed.timeCompleted)
      expect(row.result).toEqual(observed.result)
      await expect(cold.retainResult(task.id)).rejects.toThrow((kind === 'pending' || kind === 'running-pending') ? /Original task body capture unavailable/ : /body.*(unavailable|incomplete)/i)
      expect(row.retention).not.toBe('durable')
      await expect(cold.readResult(task.id, {})).rejects.toThrow(/unavailable/)
      await createNotificationDrain({ tasks: cold, reportPolicy: SHIPPING_REPORT_POLICY, admit: { async admit() { admissions++ }, wake() { wakes++ } } }).drain()
      expect(cold.notifications()).toEqual(original.notifications)
      await cold.save(); await cold.flushPersistence()
    }
    expect({ captures, callbacks, admissions, wakes }).toEqual({ captures: 0, callbacks: 0, admissions: 0, wakes: 0 })
    expect((await coordinator.snapshot!('parent')).session.events.filter(event => event.type === 'subagent/end')).toEqual([])
  } finally { await coordinator.close(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps literal v1 recovery after an explicit migration save, while body-kind alone cannot downgrade a v2 row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-migration-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, {lock:{enabled:true}}, taskDocumentStorageContract)
  const store = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w' })
  try {
    await coordinator.create({ sessionId: 'parent' }); await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 })
    await coordinator.append('child', [{ type: 'turn/start' }, { type: 'assistant/message', text: 'historical body' }, { type: 'turn/end' }])
    const current = createTaskRegistry({ coordinator, stateId: 'parent' })
    current.submit({ identity: { parentSessionId: 'parent' }, childSessionId: 'child', agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'tool' })
    await current.flushPersistence()
    const v1 = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    const results: TaskResultStore = { capture() { throw Error('No completed capture in this migration fixture') }, async read() { throw Error('unavailable') } }
    const migrating = createTaskRegistry({ coordinator, stateId: 'parent', results })
    migrating.restore(structuredClone(v1)); await migrating.save()
    const migrated = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    expect(migrated.formatVersion).toBe(2)
    expect(migrated.tasks[0]).toMatchObject({ legacyFormatVersion: 1, bodyKind: 'legacy-text' })
    const old = createTaskRegistry({ coordinator })
    old.restore(migrated)
    expect(await classifyRestoredTasks(old, coordinator)).toBe(1)
    expect(old.get('task-1')).toMatchObject({ outcome: 'completed', resultText: 'historical body' })
    const ambiguous = createTaskRegistry({ coordinator })
    ambiguous.restore({ ...structuredClone(v1), formatVersion: 2, tasks: v1.tasks.map(row => ({ ...row, bodyKind: 'legacy-text' })) })
    expect(await classifyRestoredTasks(ambiguous, coordinator)).toBe(0)
    expect(ambiguous.get('task-1')).toMatchObject({ outcome: 'recovery-required', publication: 'unqualified' })
    let captures = 0
    const migratedWriter = createTaskRegistry({ coordinator, stateId: 'parent', results: { ...results, capture(task, body, revision, execution) {
      captures++
      const scope = store.registerResultScope({ operationId: revision, sessionId: 'parent', callId: task.id, documentId: 'task-parent' }, () => true)
      return createResultCapture(body, execution!, { forceArtifact: true, openArtifact: () => store.beginResult(scope, 'json-utf8-v1') })
    } } })
    migratedWriter.restore(structuredClone(v1))
    expect(await classifyRestoredTasks(migratedWriter, coordinator)).toBe(1)
    await migratedWriter.retainResult('task-1'); await migratedWriter.save(); await migratedWriter.flushPersistence()
    const captured = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    expect(captured.tasks[0]!.legacyFormatVersion).toBeUndefined()
    expect(captured.tasks[0]!.result?.kind).toBe('retained')
    const currentAgain = createTaskRegistry({ coordinator })
    currentAgain.restore(captured)
    expect(await classifyRestoredTasks(currentAgain, coordinator)).toBe(0)
    expect(currentAgain.get('task-1')?.publication).toBe('unqualified')
    expect(captures).toBe(1)
    await old.flushPersistence(); await ambiguous.flushPersistence()
  } finally { await coordinator.close(); await store.close(); await rm(root, { recursive: true, force: true }) }
})

it('round-trips absent outcomes only for unfinished observations and keeps the terminal vocabulary and descriptors closed', () => {
  const task = { id: 'task-1', parentSessionId: 'parent', agentPath: 'root/a', description: '', prompt: '', agent: 'general', delivery: 'tool' as const, status: 'recovery-required' as const, outcome: 'recovery-required' as const, publication: 'unqualified' as const, timeCreated: 1 }
  const restore = (savedObservation: unknown, extra = {}) => () => createTaskRegistry().restore({ formatVersion: 2, tasks: [{ ...task, savedObservation, ...extra }], notifications: [] } as TaskProtocolDocument)
  for (const status of ['accepted', 'running']) expect(restore({ status })).not.toThrow()
  for (const saved of [{ status: 'completed' }, { status: 'error' }, { status: 'cancelled' }, { status: 'recovery-required' }, { status: 'running', outcome: 'invented' }, { status: 'completed', outcome: 'completed', future: true }, { status: 'running', outcome: undefined }, { status: 'running', execution: { outcome: 'unknown', dispatch: 'invented' } }]) expect(restore(saved)).toThrow(/publication/)
  expect(restore({ status: 'running' }, { legacyFormatVersion: 2 })).toThrow(/publication/)
  for (const extra of [{ legacyFormatVersion: 1 }, { legacyFormatVersion: 1, bodyKind: 'legacy-text' }, { legacyFormatVersion: 1, bodyKind: 'legacy-text', result: { version: 1, kind: 'pending', revision: 'original' } }]) expect(restore({ status: 'running' }, extra)).toThrow(/publication/)
  expect(() => createTaskRegistry().restore({ formatVersion: 4, tasks: [], notifications: [] } as never)).toThrow(/version/)
})

it('rejects inherited migration stamps and invalid current source observations before mutating restore state', () => {
  const row = { id: 'task-1', parentSessionId: 'parent', agentPath: 'root/a', description: '', prompt: '', agent: 'general', delivery: 'tool', status: 'running', timeCreated: 1 }
  for (const task of [Object.assign(Object.create({ legacyFormatVersion: 1 }), row, { bodyKind: 'legacy-text' }), ...['completed', 'error', 'cancelled', 'recovery-required'].map(status => ({ ...row, status })), { ...row, status: 'completed', outcome: 'invented' }]) {
    const tasks = createTaskRegistry()
    expect(() => tasks.restore({ formatVersion: 2, tasks: [task], notifications: [] } as TaskProtocolDocument)).toThrow(/publication|observation/)
    expect(tasks.list()).toEqual([])
    expect(task.publication).toBeUndefined()
  }
})
