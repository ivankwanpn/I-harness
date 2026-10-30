import { createHash } from 'node:crypto'
import type { TaskNotificationRecord, TaskRecord } from './types.ts'

export function notificationMessageId(taskId: string): string {
  return `msg_task_${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
}

/** Owns the existing outbox rows/counter, with no admission or wake authority. */
export class TaskNotifications {
  readonly #rows: TaskNotificationRecord[] = []
  #counter = 0
  list(): TaskNotificationRecord[] { return [...this.#rows] }
  snapshot(): TaskNotificationRecord[] { return this.#rows.map(row => ({ ...row })) }
  update(id: string, patch: Partial<Omit<TaskNotificationRecord, 'id' | 'submissionId'>>): boolean {
    const row = this.#rows.find(row => row.id === id)
    if (!row) return false
    Object.assign(row, patch)
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete row[key]
    return true
  }
  restore(rows: TaskNotificationRecord[]): void {
    for (const row of rows) {
      this.#rows.push(row)
      const match = /^notif-(\d+)$/.exec(row.id)
      if (match) this.#counter = Math.max(this.#counter, Number(match[1]))
    }
  }
  enqueue(task: TaskRecord): void {
    if (task.delivery !== 'parent' || task.outcome === undefined) return
    this.#rows.push({
      id: `notif-${++this.#counter}`, submissionId: task.id, parentSessionId: task.parentSessionId,
      messageId: notificationMessageId(task.id), state: task.outcome, description: task.description,
      text: task.outcome === 'completed' ? task.resultText ?? '' : task.error ?? task.resultText ?? '',
      status: 'pending', attempts: 0, timeCreated: Date.now(),
    })
  }
}
