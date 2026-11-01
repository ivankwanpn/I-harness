import { createHash } from 'node:crypto'
import type { TaskNotificationRecord, TaskRecord } from './types.ts'

export function notificationMessageId(taskId: string): string {
  return `msg_task_${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
}

/** Owns the existing outbox rows/counter, with no admission or wake authority. */
export class TaskNotifications {
  readonly #rows: TaskNotificationRecord[] = []
  #counter = 0
  #checkedCounter = false
  list(): TaskNotificationRecord[] { return [...this.#rows] }
  snapshot(): TaskNotificationRecord[] { return this.#rows.map(row => ({ ...row })) }
  update(id: string, patch: Partial<Omit<TaskNotificationRecord, 'id' | 'submissionId'>>): boolean {
    const row = this.#rows.find(row => row.id === id)
    if (!row) return false
    Object.assign(row, patch)
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete row[key]
    return true
  }
  restore(rows: TaskNotificationRecord[], strict = false): void {
    if (strict) {
      this.#checkedCounter = true
      const ids = new Set<string>()
      for (const row of rows) { if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('Duplicate or invalid restored notification id'); ids.add(row.id); const match = /^notif-(\d+)$/.exec(row.id); if (match && (!Number.isSafeInteger(Number(match[1])) || Number(match[1]) >= Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe restored notification counter') }
    }
    for (const row of rows) {
      this.#rows.push(row)
      const match = /^notif-(\d+)$/.exec(row.id)
      if (match) this.#counter = Math.max(this.#counter, Number(match[1]))
    }
  }
  enqueue(task: TaskRecord): void {
    if (task.delivery !== 'parent' || task.outcome === undefined) return
    if (this.#checkedCounter && this.#counter >= Number.MAX_SAFE_INTEGER) throw new Error('Notification counter exhausted')
    this.#rows.push({
      id: `notif-${++this.#counter}`, submissionId: task.id, parentSessionId: task.parentSessionId,
      messageId: notificationMessageId(task.id), state: task.outcome, description: task.description,
      text: task.outcome === 'completed' ? task.resultText ?? '' : task.error ?? task.resultText ?? '',
      status: 'pending', attempts: 0, timeCreated: Date.now(),
    })
  }
}
