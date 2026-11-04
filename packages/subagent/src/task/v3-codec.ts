import { captureTaskSnapshot } from '@i-harness/session-persistence/internal/task-document-operations'
import type { TaskProtocolDocument } from './types.ts'
import { validateChildBirth } from './child-birth-validation.ts'
import { validateTaskPublicationRows } from './validation.ts'
import { calculateTaskDocumentConsistency } from './consistency.ts'
import type { SessionEventView } from '@i-harness/core-session'

/** Isolated future codec. No storage, runtime-restore or physical-version authority. */
export function captureTaskV3Document(value: unknown): TaskProtocolDocument & {formatVersion:3} {
  const doc = captureTaskSnapshot(value) as TaskProtocolDocument
  if (!doc || typeof doc !== 'object' || Object.getOwnPropertyDescriptor(doc,'formatVersion')?.value !== 3) throw new Error('Unsupported task v3 document version')
  validateV3(doc)
  validateTaskPublicationRows(doc)
  return doc as TaskProtocolDocument & {formatVersion:3}
}
export const taskV3DocumentCodec = Object.freeze({
  validate(value:unknown):void { captureTaskV3Document(value) },
  consistency(parent:string,events:readonly SessionEventView[],seedLength:number,value:unknown) {
    return calculateTaskDocumentConsistency(parent,events,seedLength,captureTaskV3Document(value))
  },
})
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
    fields(row, ['id','parentSessionId','agentPath','description','prompt','agent','delivery','status','timeCreated'], ['toolCallId','callEventSeq','childSessionId','jobId','modelLabel','outcome','resultText','error','bodyKind','legacyFormatVersion','result','publication','savedObservation','retention','retentionError','recoveryReason','timeStarted','timeCompleted','childBirth','projectionWarning'])
    if (!nonempty(row.id) || !text(row.parentSessionId) || !nonempty(row.agentPath) || !text(row.description) || !text(row.prompt) || !nonempty(row.agent) || !['tool','parent'].includes(row.delivery) || !count(row.timeCreated) || row.callEventSeq !== undefined && !count(row.callEventSeq) || [row.toolCallId,row.childSessionId,row.jobId,row.modelLabel,row.resultText,row.error,row.retentionError].some(v => v !== undefined && !text(v)) || [row.timeStarted,row.timeCompleted].some(v => v !== undefined && !count(v)) || row.bodyKind !== undefined && row.bodyKind !== 'legacy-text' || row.retention !== undefined && !['memory','pending','durable','failed'].includes(row.retention) || row.recoveryReason !== undefined && !['dispatch-unknown','response-interrupted'].includes(row.recoveryReason)) throw new Error('Invalid task v3 row')
    if (!['accepted','running','completed','error','cancelled','recovery-required'].includes(row.status) || row.outcome !== undefined && !['completed','error','cancelled','recovery-required'].includes(row.outcome)) throw new Error('Invalid task v3 observation domain')
    if (row.projectionWarning !== undefined && row.projectionWarning !== 'terminal-without-turn-end' && row.projectionWarning !== 'missing-child-session') throw new Error('Invalid task v3 projection warning')
    if (row.childBirth !== undefined) validateChildBirth(row)
  }
  for (const n of doc.notifications) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error('Invalid notification')
    fields(n, ['id','submissionId','parentSessionId','messageId','state','description','text','status','attempts','timeCreated'], ['timeDelivered','timeWoken','error'])
    if (!nonempty(n.id) || !nonempty(n.submissionId) || !text(n.parentSessionId) || !nonempty(n.messageId) || !['completed','error','cancelled','recovery-required'].includes(n.state) || !text(n.description) || !text(n.text) || !['pending','delivered','woken','error','suppressed'].includes(n.status) || !count(n.attempts) || !count(n.timeCreated) || n.timeDelivered !== undefined && !count(n.timeDelivered) || n.timeWoken !== undefined && !count(n.timeWoken) || n.error !== undefined && !text(n.error)) throw new Error('Invalid notification')
  }
}
