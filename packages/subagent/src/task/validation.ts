import { validRetainedResultRevision } from '@i-harness/core-session'
import { validTaskResultPublication, validTaskObservation } from './publication.ts'
import type { RetainedTaskResult } from './result.ts'
import type { TaskProtocolDocument } from './types.ts'
import { types } from 'node:util'
import { captureTaskSnapshot } from '@i-harness/session-persistence/internal/task-document-operations'
import { validateChildBirth } from './child-birth-validation.ts'

export function validTaskResult(value: unknown): value is RetainedTaskResult {
  return validRetainedResultRevision(value) && (value.kind === 'pending'
    || value.envelope.retention.kind !== 'inline' && value.envelope.preview === '' && value.envelope.media.length === 0)
}

export function validateTaskDocument(doc: TaskProtocolDocument): void {
  if (doc && typeof doc === 'object' && types.isProxy(doc)) throw new TypeError('Invalid task document')
  const version = doc && typeof doc === 'object' ? Object.getOwnPropertyDescriptor(doc, 'formatVersion') : undefined
  if (version && !('value' in version)) throw new TypeError('Invalid task document version')
  if (version?.value === 3) { doc = captureTaskSnapshot(doc) as TaskProtocolDocument; validateV3(doc) }
  if (!doc || ![1, 2, 3].includes(doc.formatVersion) || !Array.isArray(doc.tasks) || !Array.isArray(doc.notifications)) throw new Error('Unsupported task document version')
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

const text = (v: unknown): v is string => typeof v === 'string'
const nonempty = (v: unknown) => text(v) && v.length > 0
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0
function fields(value: object, required: string[], optional: string[]) {
  if (required.some(k => !Object.hasOwn(value,k)) || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new Error('Invalid task v3 fields')
}
function validateV3(doc: TaskProtocolDocument) {
  fields(doc, ['formatVersion','tasks','notifications'], [])
  if (!Array.isArray(doc.tasks) || !Array.isArray(doc.notifications)) throw new Error('Invalid task v3 arrays')
  for (const row of doc.tasks) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid task v3 row')
    fields(row, ['id','parentSessionId','agentPath','description','prompt','agent','delivery','status','timeCreated'], ['toolCallId','callEventSeq','childSessionId','jobId','modelLabel','outcome','resultText','error','bodyKind','legacyFormatVersion','result','publication','savedObservation','retention','retentionError','recoveryReason','timeStarted','timeCompleted','childBirth'])
    if (!nonempty(row.id) || !text(row.parentSessionId) || !nonempty(row.agentPath) || !text(row.description) || !text(row.prompt) || !nonempty(row.agent) || !['tool','parent'].includes(row.delivery) || !count(row.timeCreated) || row.callEventSeq !== undefined && !count(row.callEventSeq) || [row.toolCallId,row.childSessionId,row.jobId,row.modelLabel,row.resultText,row.error,row.retentionError].some(v => v !== undefined && !text(v)) || [row.timeStarted,row.timeCompleted].some(v => v !== undefined && !count(v)) || row.bodyKind !== undefined && row.bodyKind !== 'legacy-text' || row.retention !== undefined && !['memory','pending','durable','failed'].includes(row.retention) || row.recoveryReason !== undefined && !['dispatch-unknown','response-interrupted'].includes(row.recoveryReason)) throw new Error('Invalid task v3 row')
    if (row.childBirth !== undefined) validateChildBirth(row)
  }
  for (const n of doc.notifications) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error('Invalid notification')
    fields(n, ['id','submissionId','parentSessionId','messageId','state','description','text','status','attempts','timeCreated'], ['timeDelivered','timeWoken','error'])
    if (!nonempty(n.id) || !nonempty(n.submissionId) || !text(n.parentSessionId) || !nonempty(n.messageId) || !['completed','error','cancelled','recovery-required'].includes(n.state) || !text(n.description) || !text(n.text) || !['pending','delivered','woken','error','suppressed'].includes(n.status) || !count(n.attempts) || !count(n.timeCreated) || n.timeDelivered !== undefined && !count(n.timeDelivered) || n.timeWoken !== undefined && !count(n.timeWoken) || n.error !== undefined && !text(n.error)) throw new Error('Invalid notification')
  }
}
