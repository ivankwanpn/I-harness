import { validRetainedResultRevision } from '@i-harness/core-session'
import { validTaskResultPublication, validTaskObservation } from './publication.ts'
import type { RetainedTaskResult } from './result.ts'
import type { TaskProtocolDocument } from './types.ts'

export function validTaskResult(value: unknown): value is RetainedTaskResult {
  return validRetainedResultRevision(value) && (value.kind === 'pending'
    || value.envelope.retention.kind !== 'inline' && value.envelope.preview === '' && value.envelope.media.length === 0)
}

export function validateTaskDocument(doc: TaskProtocolDocument): void {
  if (!doc || ![1, 2].includes(doc.formatVersion) || !Array.isArray(doc.tasks) || !Array.isArray(doc.notifications)) throw new Error('Unsupported task document version')
  for (const task of doc.tasks) {
    const legacy = Object.getOwnPropertyDescriptor(task, 'legacyFormatVersion')
    if ('legacyFormatVersion' in task && (!legacy || !('value' in legacy) || !legacy.enumerable || legacy.value !== 1 || task.bodyKind !== 'legacy-text'
      || task.result !== undefined || task.publication !== undefined || task.savedObservation !== undefined)) throw new Error('Unsupported retained task publication legacy provenance')
    if (doc.formatVersion === 1 && (task.result !== undefined || task.publication !== undefined || task.savedObservation !== undefined)) throw new Error('Invalid legacy task result descriptor')
    if (!validTaskResultPublication(task)) throw new Error('Unsupported retained task publication metadata')
    if (doc.formatVersion === 2 && !legacy && !validTaskObservation({ status: task.status, ...(task.outcome !== undefined ? { outcome: task.outcome } : {}) })) throw new Error('Invalid current task observation')
    if (task.result !== undefined && !validTaskResult(task.result)) throw new Error('Invalid retained task result descriptor')
    if (task.result && Buffer.byteLength(JSON.stringify({ resultText: task.resultText, error: task.error })) > 2048) throw new Error('Task result preview exceeds budget')
  }
}
