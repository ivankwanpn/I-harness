import { describe, expect, it } from 'vitest'
import { createTaskRegistry } from '../src/task-protocol.ts'
import { createNotificationDrain, DeliverySuppressedError, renderTaskNotification } from '../src/task-notification.ts'

describe('ordinary source notification contract', () => {
  it.each(['completed', 'error', 'cancelled', 'recovery-required'] as const)('unbound %s rows stay readable and never call generic admission', async outcome => {
    const tasks = createTaskRegistry()
    const task = tasks.submit({ identity: { parentSessionId: 'parent', callEventSeq: 1 }, agentPath: 'root/helper', description: 'helper', prompt: 'p', agent: 'general', delivery: 'parent' })
    tasks.terminalize({ taskId: task.id, outcome, resultText: 'original retained observation' })
    let generic = 0, typed = 0, wakes = 0
    const drain = createNotificationDrain({ tasks, evidence: () => undefined, admit: {
      admit: async () => { generic++ }, wake: () => { wakes++ },
      admitTaskDelivery: async () => { typed++; throw new Error('Unbound source must never reach recipient') },
    } })
    await Promise.all([drain.drain(), drain.drain(), drain.drain()])
    expect([generic, typed, wakes]).toEqual([0, 0, 0])
    expect(tasks.notifications()[0]).toMatchObject({ status: 'pending', attempts: 0 })
    expect(tasks.get(task.id)).toMatchObject({ outcome, resultText: 'original retained observation' })
    expect(Object.keys(tasks.get(task.id)!)).not.toContain('generationId')
  })

  // Refusal unit controls: successful source proof/execution use the actual service tests.
  it.each(['matching', 'wrong-id', 'raw-code'] as const)('suppression requires actual class and expected witness identity (%s)', async kind => {
    const tasks = createTaskRegistry()
    const task = tasks.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/helper', description: 'helper', prompt: 'p', agent: 'general', delivery: 'parent' })
    tasks.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'original' })
    let calls = 0, wakes = 0
    const drain = createNotificationDrain({ tasks, evidence: () => ({ evidence: { sourceSeq: 1, terminalSeq: 2 }, expectedInputId: 'delivery-original' }), admit: {
      admit: async () => { throw new Error('generic forbidden') }, wake: () => { wakes++ },
      admitTaskDelivery: async () => { calls++; throw kind === 'raw-code' ? Object.assign(new Error('unclassified original failure'), { code: 'DELIVERY_SUPPRESSED' }) : new DeliverySuppressedError(kind === 'matching' ? 'delivery-original' : 'delivery-other') },
    } })
    expect(await drain.drain()).toBe(0)
    expect(tasks.notifications()[0]).toMatchObject({ status: kind === 'matching' ? 'suppressed' : 'error' })
    expect(tasks.notifications()[0]!.timeDelivered).toBeUndefined()
    expect(tasks.notifications()[0]!.timeWoken).toBeUndefined()
    expect(wakes).toBe(0); expect(calls).toBe(1)
    if (kind === 'matching') { await drain.drain(); expect(calls).toBe(1) }
  })

  it('a receipt for another original delivery cannot acknowledge this outbox row', async () => {
    const tasks = createTaskRegistry()
    const task = tasks.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'root/helper', description: 'helper', prompt: 'p', agent: 'general', delivery: 'parent' })
    tasks.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'original' })
    let wakes = 0
    const drain = createNotificationDrain({ tasks, evidence: () => ({ evidence: { sourceSeq: 1, terminalSeq: 2 }, expectedInputId: 'delivery-original' }), admit: {
      admit: async () => { throw new Error('generic forbidden') }, wake: () => { wakes++ },
      admitTaskDelivery: async () => ({ inputId: 'delivery-other', disposition: 'claimed', durability: 'durable' }),
    } })
    expect(await drain.drain()).toBe(0)
    expect(tasks.notifications()[0]).toMatchObject({ status: 'error' })
    expect(tasks.notifications()[0]!.timeDelivered).toBeUndefined()
    expect(tasks.notifications()[0]!.timeWoken).toBeUndefined()
    expect(wakes).toBe(0)
  })

  it('renderTaskNotification keeps source-owned presentation shape', () => {
    expect(renderTaskNotification('completed', 'task-1', 'helper', 'original')).toBe('<task id="task-1" state="completed">\n<summary>helper</summary>\n<task_result>\noriginal\n</task_result>\n</task>')
  })
})
