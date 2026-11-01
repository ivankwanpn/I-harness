import { TaskRecords } from './records.ts'
import { TaskNotifications } from './notifications.ts'
import { validateTaskDocument } from './validation.ts'
import { unqualifyRestoredTask } from './publication.ts'
import type { TaskProtocolDocument } from './types.ts'

/** Detached data and indexes only: no persistence, callbacks, or live producer. */
export function stageTaskRestore(observation: TaskProtocolDocument, reportPolicy: boolean, resultReader: boolean) {
  validateTaskDocument(observation)
  if (observation.formatVersion !== 1 && observation.formatVersion !== 2 && observation.formatVersion !== 3) throw new Error('Unsupported task document version')
  const doc = structuredClone(observation), records = new TaskRecords(), notifications = new TaskNotifications()
  records.seedRestoredCounter(doc.tasks, true); notifications.restore(doc.notifications, true)
  let anonymous = 0
  for (const task of doc.tasks) {
    if (typeof task.id !== 'string' || !task.id || typeof task.parentSessionId !== 'string' || task.callEventSeq !== undefined && (!Number.isSafeInteger(task.callEventSeq) || task.callEventSeq < 0) || task.toolCallId !== undefined && typeof task.toolCallId !== 'string' || task.childSessionId !== undefined && typeof task.childSessionId !== 'string') throw new Error('Invalid restored task identity')
    records.checkRestoredId(task.id)
    if (doc.formatVersion === 1) { task.bodyKind = 'legacy-text'; task.legacyFormatVersion = 1 } else unqualifyRestoredTask(task)
    if (reportPolicy && task.outcome !== undefined) {
      if (task.legacyFormatVersion === 1 && !task.result) { task.retention = 'durable'; delete task.retentionError }
      else if (task.result?.kind === 'pending') { task.retention = 'pending'; delete task.retentionError }
      else if (task.result?.kind === 'retained' && task.result.envelope.retention.kind === 'artifact' && resultReader) { task.retention = 'durable'; delete task.retentionError }
      else { task.retention = 'failed'; task.retentionError = task.result?.kind === 'retained' ? 'Retained task body reader unavailable' : 'Retained task body incomplete' }
    }
    if (doc.formatVersion === 3) records.protectSubmission(task)
    records.insertRestored(task)
    if (task.callEventSeq === undefined && task.toolCallId === undefined) anonymous++
    records.indexRestored(task, anonymous, true)
  }
  return { records, notifications, version: observation.formatVersion }
}
