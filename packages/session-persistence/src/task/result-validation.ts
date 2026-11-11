import { validRetainedResultRevision } from '@i-harness/core-session'
import { validPublicationDescriptor, validSavedObservation } from '../format/result-publication.ts'
import type { TaskOutcome, TaskStatus, TaskSavedObservation, TaskProtocolDocument } from './types.ts'
import type { RetainedResultRevision as RetainedTaskResult } from '@i-harness/core-session'

/** Task rows persist their own status/outcome domain. Reusing the state/job
 * observation schema would reject an owner's own legally saved current-format
 * document on its next cold restore. */
const taskStatuses: readonly TaskStatus[] = ['accepted', 'running', 'completed', 'error', 'cancelled', 'recovery-required']
const taskOutcomes: readonly TaskOutcome[] = ['completed', 'error', 'cancelled', 'recovery-required']

export function validTaskObservation(saved: unknown): saved is TaskSavedObservation {
  if (saved && typeof saved === 'object' && Object.hasOwn(saved, 'outcome')) return validSavedObservation(saved, taskStatuses, taskOutcomes)
  return validSavedObservation(saved, ['accepted', 'running'])
}

export function validTaskResultPublication(row: object): boolean {
  return validPublicationDescriptor(row, validTaskObservation)
}

export function validTaskResult(value: unknown): value is RetainedTaskResult {
  return validRetainedResultRevision(value) && (value.kind === 'pending'
    || value.envelope.retention.kind !== 'inline' && value.envelope.preview === '' && value.envelope.media.length === 0)
}

/** Shared retained-publication checks; caller owns document/version validation. */
export function validateTaskPublicationRows(doc: TaskProtocolDocument): void {
  for (const task of doc.tasks) {
    const legacy = Object.getOwnPropertyDescriptor(task, 'legacyFormatVersion')
    if ('legacyFormatVersion' in task && (!legacy || !('value' in legacy) || !legacy.enumerable || legacy.value !== 1 || task.bodyKind !== 'legacy-text'
      || task.result !== undefined || task.publication !== undefined || task.savedObservation !== undefined)) throw new Error('Unsupported retained task publication legacy provenance')
    if (doc.formatVersion === 1 && (task.result !== undefined || task.publication !== undefined || task.savedObservation !== undefined)) throw new Error('Invalid legacy task result descriptor')
    if (!validTaskResultPublication(task)) throw new Error('Unsupported retained task publication metadata')
    if (doc.formatVersion !== 1 && !legacy && !validTaskObservation({ status: task.status, ...(task.outcome !== undefined ? { outcome: task.outcome } : {}) })) throw new Error('Invalid current task observation')
    if (task.result !== undefined && !validTaskResult(task.result)) throw new Error('Invalid retained task result descriptor')
    if (task.result && Buffer.byteLength(JSON.stringify({ resultText: task.resultText, error: task.error })) > 2048) throw new Error('Task result preview exceeds budget')
  }
}
