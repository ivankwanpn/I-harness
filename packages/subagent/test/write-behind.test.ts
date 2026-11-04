import { expect, it } from 'vitest'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { TaskPersistence, taskDocKey } from '../src/task/persistence.ts'
import type { TaskProtocolDocument } from '../src/task/types.ts'

const doc = (id: string): TaskProtocolDocument => ({ formatVersion: 1, tasks: [{ id, parentSessionId: 'parent' } as never], notifications: [] })

it('coalesces rapid legacy saves into one write of the latest snapshot (D-01 write-behind)', async () => {
  const writes: { key: string; value: TaskProtocolDocument }[] = []
  const coordinator = { putDocument: async (key: string, value: TaskProtocolDocument) => { writes.push({ key, value }) } } as unknown as SessionCoordinator
  let current = doc('a')
  const persistence = new TaskPersistence(coordinator, 'parent', false, () => current)
  const first = persistence.save()
  current = doc('b'); const second = persistence.save()
  current = doc('c'); const third = persistence.save()
  await Promise.all([first, second, third])
  expect(writes).toHaveLength(1)
  expect(writes[0]!.key).toBe(taskDocKey('parent'))
  expect(writes[0]!.value.tasks[0]!.id).toBe('c')
})

it('flush waits for an in-flight coalesced write instead of resolving early (D-01 write-behind)', async () => {
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const coordinator = { putDocument: () => new Promise<void>(resolve => { started(); release = resolve }) } as unknown as SessionCoordinator
  const persistence = new TaskPersistence(coordinator, 'parent', false, () => doc('a'))
  const save = persistence.save()
  await entered
  const flush = persistence.flush()
  let flushed = false
  void flush.then(() => { flushed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(flushed).toBe(false)
  release()
  await save
  await flush
  expect(flushed).toBe(true)
})

it('rejects the coalesced waiter when the document write fails (D-01 write-behind)', async () => {
  const coordinator = { putDocument: async () => { throw new Error('disk full') } } as unknown as SessionCoordinator
  const persistence = new TaskPersistence(coordinator, 'parent', false, () => doc('a'))
  await expect(persistence.save()).rejects.toThrow('disk full')
})
