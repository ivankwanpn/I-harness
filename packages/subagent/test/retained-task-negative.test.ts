import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createResultCapture } from '../../output-retention/src/index.ts'
import { createTaskRegistry, SHIPPING_REPORT_POLICY, taskDocKey, type TaskProtocolDocument, type TaskResultStore } from '../src/index.ts'

const row = {
  id: 'task-1', parentSessionId: 'parent', agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general',
  delivery: 'tool' as const, status: 'completed' as const, outcome: 'completed' as const, timeCreated: 1,
}

/** Auxiliary rows use the same closed publication descriptor as the state
 * mirrors; a parsed document cannot invent a committed observation. */
it('refuses forged task publication/saved-observation descriptors at the actual restore entry', () => {
  const registry = () => createTaskRegistry({ reportPolicy: SHIPPING_REPORT_POLICY })
  expect(() => registry().restore({
    formatVersion: 2, tasks: [{ ...row, resultText: 'preview', result: { version: 1, kind: 'pending', revision: 'original' }, publication: 'future-confirmation' }],
    notifications: [],
  } as unknown as TaskProtocolDocument)).toThrow(/publication/)
  expect(() => registry().restore({
    formatVersion: 2, tasks: [{ ...row, resultText: 'preview', result: { version: 1, kind: 'pending', revision: 'original' }, publication: 'unqualified' }],
    notifications: [],
  } as unknown as TaskProtocolDocument)).toThrow(/publication/)
  expect(() => registry().restore({
    formatVersion: 2, tasks: [{ ...row, resultText: 'preview', result: { version: 1, kind: 'pending', revision: 'original' }, savedObservation: { status: 'invented' } }],
    notifications: [],
  } as unknown as TaskProtocolDocument)).toThrow(/publication/)
  expect(() => registry().restore({
    formatVersion: 2, tasks: [{ ...row, resultText: 'preview', result: { version: 1, kind: 'pending', revision: 'original' }, savedObservation: { status: 'completed', execution: { outcome: 'completed', dispatch: 'dispatched' } } }],
    notifications: [],
  } as unknown as TaskProtocolDocument)).toThrow(/publication/)
})

/** The task owner persists {status, outcome, execution}. Every legal one must
 * round-trip, and only the closed vocabulary is accepted. */
it.each([
  ['completed', 'completed'], ['error', 'error'], ['cancelled', 'cancelled'], ['recovery-required', 'recovery-required'],
] as const)('accepts its own current-format %s row and rejects invalid domain values', (status, outcome) => {
  const registry = () => createTaskRegistry({ reportPolicy: SHIPPING_REPORT_POLICY })
  const base = { ...row, status, outcome, resultText: 'preview', result: { version: 1, kind: 'pending' as const, revision: 'original' },
    publication: 'unqualified' as const, savedObservation: { status, outcome, execution: { outcome: 'succeeded' as const, dispatch: 'dispatched' as const } } }
  expect(() => registry().restore({ formatVersion: 2, tasks: [{ ...base }], notifications: [] } as unknown as TaskProtocolDocument)).not.toThrow()
  expect(() => registry().restore({ formatVersion: 2, tasks: [{ ...base, savedObservation: { ...base.savedObservation, outcome: 'invented' } }], notifications: [] } as unknown as TaskProtocolDocument)).toThrow(/publication/)
  expect(() => registry().restore({ formatVersion: 2, tasks: [{ ...base, savedObservation: { status, execution: { outcome: 'succeeded', dispatch: 'dispatched' } } }], notifications: [] } as unknown as TaskProtocolDocument)).toThrow(/publication/)
  expect(() => registry().restore({ formatVersion: 2, tasks: [{ ...base, savedObservation: { ...base.savedObservation, extra: 1 } }], notifications: [] } as unknown as TaskProtocolDocument)).toThrow(/publication/)
  expect(() => registry().restore({ formatVersion: 1, tasks: [{ ...base }], notifications: [] } as unknown as TaskProtocolDocument)).toThrow(/legacy/)
})

it('keeps the current task-document version and result descriptors when a cold reader has no result owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-negative-resave-'))
  let coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  let store = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w' })
  const results: TaskResultStore = {
    capture(task, body, revision, execution) {
      const scope = store.registerResultScope({ operationId: revision, sessionId: 'parent', callId: task.id, documentId: 'task-parent' }, () => true)
      return createResultCapture(body, execution!, { forceArtifact: true, openArtifact: () => store.beginResult(scope, 'json-utf8-v1') })
    },
    read: (_task, ref, args) => store.readResult({ sessionId: 'parent' }, { ref, ...args }),
  }
  try {
    await coordinator.create({ sessionId: 'parent' })
    const writer = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, results })
    const task = writer.submit({ identity: { parentSessionId: 'parent', callEventSeq: 1 }, agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' })
    writer.claim(task.id)
    writer.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'original bytes', error: '' })
    await writer.retainResult(task.id)
    if (task.result?.kind !== 'retained') throw new Error('Expected retained source fixture')
    const revision = task.result.revision
    await writer.flushPersistence()
    await coordinator.close(); await store.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
    store = createContextOutputService({ root: join(root, 'results'), workspaceId: 'w' })
    // A reader composed without the durable result owner must not downgrade or
    // drop the original descriptors on its own save.
    const reader = createTaskRegistry({ coordinator, stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY })
    reader.restore(await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument)
    expect(reader.get(task.id)?.retention).toBe('failed')
    expect(reader.get(task.id)?.result).toMatchObject({ kind: 'retained', revision })
    await reader.save()
    const saved = await coordinator.getDocument(taskDocKey('parent')) as TaskProtocolDocument
    expect(saved.formatVersion).toBe(2)
    expect(saved.tasks[0]?.result).toMatchObject({ kind: 'retained', revision })
    expect(saved.tasks[0]?.retention).toBe('failed')
    expect(saved.tasks[0]?.retentionError).toMatch(/unavailable|owner/i)
  } finally {
    await coordinator.close(); await store.close(); await rm(root, { recursive: true, force: true })
  }
})
