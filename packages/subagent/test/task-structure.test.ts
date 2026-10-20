import { expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { TaskRecord, TaskSubmissionInput, TaskProtocolDocument } from '../src/task-protocol.ts'

const evidence = resolve(process.env.IH_STRUCTURE_EVIDENCE_ROOT ?? '.tmp/task-structure')
if (!process.env.IH_CONFIG_DIR || existsSync(join(evidence, 'evidence-seal.json'))) throw Error('Choose isolated unsealed structure evidence')
const { createTaskRegistry, TaskConcurrencyLimitError } = await import('../src/task-protocol.ts')
const { SHIPPING_REPORT_POLICY } = await import('../src/index.ts')
const { createSessionCoordinator } = await import('@i-harness/session-persistence')
const { createJsonlBackend } = await import('../../session-persistence-jsonl/src/index.ts')
const input: TaskSubmissionInput = { identity: { parentSessionId: 'parent', callEventSeq: 1 }, childSessionId: 'original-child', agentPath: 'root/a', description: 'a', prompt: 'go', agent: 'general', delivery: 'parent' }
const row = (id: string, extra: Partial<TaskRecord> = {}): TaskRecord => ({ id, parentSessionId: 'parent', callEventSeq: 5, childSessionId: 'shared-child', agentPath: 'root/restored', description: 'old', prompt: 'old', agent: 'general', delivery: 'parent', status: 'completed', outcome: 'completed', timeCreated: 1, ...extra })

it('checks capacity before exact retry; adoption does not save or publish and claim preserves the original object/backlink', async () => {
  const writes = vi.fn(async () => {})
  const tasks = createTaskRegistry({ coordinator: { putDocument: writes } as never, stateId: 'parent' })
  const first = tasks.submit(input), listener = vi.fn()
  tasks.subscribe(first.id, listener)
  await tasks.flushPersistence()
  expect(tasks.submit({ ...input, description: 'ignored on adoption' })).toBe(first)
  await tasks.flushPersistence()
  expect(writes).toHaveBeenCalledTimes(1); expect(listener).not.toHaveBeenCalled()
  expect(tasks.claim(first.id, 'replacement-child', 'model', 'job')).toBe(true)
  expect(tasks.get(first.id)).toBe(first); expect(tasks.getByChildSession('original-child')).toBe(first)
  expect(tasks.getByChildSession('replacement-child')).toBeUndefined()
  expect(first).toMatchObject({ status: 'running', modelLabel: 'model', jobId: 'job' })
  await tasks.flushPersistence()
  const full = createTaskRegistry({ maxConcurrency: 1 }); full.submit(input)
  expect(() => full.submit(input)).toThrow(TaskConcurrencyLimitError)
})

it('restores supplied objects in order and lets duplicate identity/child keys replace only the indexes', () => {
  const tasks = createTaskRegistry({ reportPolicy: SHIPPING_REPORT_POLICY })
  const first = row('task-4'), second = row('task-9')
  tasks.restore({ formatVersion: 1, tasks: [first, second], notifications: [] })
  expect(tasks.list()).toEqual([first, second]); expect(tasks.get(first.id)).toBe(first); expect(tasks.get(second.id)).toBe(second)
  expect(first).toMatchObject({ bodyKind: 'legacy-text', retention: 'durable' })
  expect(tasks.getByIdentity({ parentSessionId: 'parent', callEventSeq: 5 })).toBe(second)
  expect(tasks.getByChildSession('shared-child')).toBe(second)
  expect(tasks.submit(input).id).toBe('task-10')
})

it('late duplicate restore keeps earlier object/outbox/counter mutations and skips final publication; malformed input mutates nothing', async () => {
  const tasks = createTaskRegistry({ reportPolicy: SHIPPING_REPORT_POLICY })
  const existing = tasks.submit(input), listener = vi.fn(); tasks.subscribe(existing.id, listener)
  const earlier = row('task-40'), duplicate = row(existing.id)
  const notification = { id: 'notif-60', submissionId: 'task-40', parentSessionId: 'parent', messageId: 'old', state: 'completed' as const, description: '', text: '', status: 'pending' as const, attempts: 0, timeCreated: 1 }
  expect(() => tasks.restore({ formatVersion: 1, tasks: [earlier, duplicate, row('task-90')], notifications: [notification] })).toThrow('duplicate task id')
  expect(tasks.get(earlier.id)).toBe(earlier); expect(earlier.bodyKind).toBe('legacy-text'); expect(duplicate.bodyKind).toBeUndefined()
  expect(tasks.notifications()[0]).toBe(notification); expect(listener).not.toHaveBeenCalled()
  const next = tasks.submit({ ...input, identity: { parentSessionId: 'parent', callEventSeq: 2 } })
  expect(next.id).toBe('task-91'); tasks.terminalize({ taskId: next.id, outcome: 'completed' })
  expect(tasks.notifications().at(-1)?.id).toBe('notif-61')
  const malformed = row('task-999', { result: { kind: 'invalid' } as never })
  const before = tasks.list(); const outbox = tasks.notifications()
  expect(() => tasks.restore({ formatVersion: 2, tasks: [malformed], notifications: [notification] })).toThrow('Invalid retained task result')
  expect(tasks.list()).toEqual(before); expect(tasks.notifications()).toEqual(outbox); expect(malformed.bodyKind).toBeUndefined()
  expect(tasks.submit({ ...input, identity: { parentSessionId: 'parent', callEventSeq: 3 } }).id).toBe('task-92')
  await tasks.flushPersistence()
})

it.each([false, true])('held actual coordinator preserves strict=%s snapshot timing, shallow nesting, FIFO failure continuation and quiescent flush', async strict => {
  await mkdir(evidence, { recursive: true }); const root = await mkdtemp(join(evidence, 'coordinator-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const documents: TaskProtocolDocument[] = []; let fail = false
  const original = (strict ? coordinator.putDocumentStrict! : coordinator.putDocument).bind(coordinator)
  const strictCoordinator = coordinator as typeof coordinator & { putDocumentStrict: NonNullable<typeof coordinator.putDocumentStrict> }
  const heldWrite = async (key: string, data: unknown) => {
    documents.push(data as TaskProtocolDocument)
    if (documents.length === 1) { entered.resolve(); await release.promise }
    if (fail) { fail = false; throw Error('held write failure') }
    return original(key, data)
  }
  const spy = strict
    ? vi.spyOn(strictCoordinator, 'putDocumentStrict').mockImplementation(heldWrite)
    : vi.spyOn(coordinator, 'putDocument').mockImplementation(heldWrite)
  const callback = vi.fn()
  const tasks = createTaskRegistry({ coordinator, stateId: 'parent', ...(strict ? { reportPolicy: SHIPPING_REPORT_POLICY } : {}), onTerminalized: callback })
  try {
    await coordinator.create({ sessionId: 'parent' })
    const task = tasks.submit(input); await entered.promise
    task.savedObservation = { status: 'completed', outcome: 'completed' }
    tasks.claim(task.id)
    task.savedObservation.status = 'error'
    tasks.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'done' })
    expect(documents[0]!.tasks[0]!.status).toBe('accepted')
    expect(callback).toHaveBeenCalledTimes(strict ? 0 : 1)
    release.resolve(); await tasks.flushPersistence(); await Promise.resolve()
    expect(documents[1]!.tasks[0]!.status).toBe(strict ? 'running' : 'completed')
    expect(documents[1]!.tasks[0]!.savedObservation).toBe(task.savedObservation)
    expect(documents[1]!.tasks[0]!.savedObservation!.status).toBe('error')
    expect(callback).toHaveBeenCalledTimes(1)
    fail = true; await expect(tasks.save()).rejects.toThrow('held write failure')
    await tasks.save(); const count = documents.length; await tasks.flushPersistence(); expect(documents).toHaveLength(count)
  } finally { release.resolve(); await tasks.flushPersistence(); spy.mockRestore(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each([false, true])('terminal callback follows the original retention success/failure once (failure=%s)', async failure => {
  const release = Promise.withResolvers<void>(), callback = vi.fn(), observations: unknown[] = []
  const tasks = createTaskRegistry({ stateId: 'parent', reportPolicy: SHIPPING_REPORT_POLICY, coordinator: { putDocumentStrict: async () => { await release.promise; if (failure) throw Error('retention failed') } } as never, onTerminalized: callback })
  const task = tasks.submit(input); tasks.subscribe(task.id, value => observations.push(value.retention))
  expect(tasks.terminalize({ taskId: task.id, outcome: 'completed' })).toBe(true)
  expect(callback).not.toHaveBeenCalled(); expect(observations).toEqual(['pending'])
  release.resolve(); await tasks.flushPersistence(); await Promise.resolve()
  expect(task.retention).toBe(failure ? 'failed' : 'durable'); expect(callback).toHaveBeenCalledTimes(1)
  expect(callback.mock.calls[0]![0]).toBe(task)
  expect(tasks.terminalize({ taskId: task.id, outcome: 'error' })).toBe(false)
  expect(callback).toHaveBeenCalledTimes(1)
})
