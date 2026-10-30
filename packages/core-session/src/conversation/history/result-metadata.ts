import type { SessionEventView } from '../../managed/types.ts'
import { managedResultSlots } from '../../results/projection.ts'
import { resultData as data, resultScalars, closedResultMetadata } from '../../results/metadata.ts'
import type { LegacyRef, ManagedResultObservation } from '../selected-results-types.ts'

export interface ResultFactMetadata {
  readonly resultDeclarations?: readonly ManagedResultObservation[]
  readonly legacyResult?: LegacyRef
  readonly cellId?: string
  readonly cellSessionId?: string
  readonly parentCallId?: string
  readonly cellState?: string
  readonly nativeCallId?: string
  readonly nativeName?: string
  readonly nativeEventSeq?: number
  readonly resultExecution?: { outcome: string; dispatch: string }
  readonly taskId?: string
  readonly taskOutcome?: string
  readonly resultRevision?: string
  readonly jobId?: string
  readonly jobStatus?: string
}
export function legacyResultMetadata(raw: unknown): LegacyRef {
  const keys = ['id', 'workspaceId', 'sessionId', 'callId', 'label', 'revision', 'bytes', 'originalBytes', 'complete', 'expiresAt']
  closedResultMetadata(raw, [...keys, 'source'])
  const ref = resultScalars(raw, keys)
  if (['id', 'workspaceId', 'sessionId', 'callId', 'revision'].some(key => typeof ref[key] !== 'string' || !ref[key]) || typeof ref.label !== 'string'
    || ['bytes', 'originalBytes'].some(key => !Number.isSafeInteger(ref[key]) || (ref[key] as number) < 0) || typeof ref.complete !== 'boolean' || typeof ref.expiresAt !== 'number') throw new TypeError('Invalid legacy result metadata')
  const source = data(raw, 'source')
  if (source) closedResultMetadata(source, ['sourceId', 'path', 'revision', 'readonly'])
  return { ...ref, ...(source ? { source: resultScalars(source, ['sourceId', 'path', 'revision', 'readonly']) } : {}) } as LegacyRef
}
export function resultFactMetadata(event: SessionEventView): ResultFactMetadata {
  const type = data(event, 'type'), declarations = managedResultSlots(event)
  const result: Record<string, unknown> = declarations.length ? { resultDeclarations: declarations } : {}
  const copy = (target: string, object: unknown, key: string) => {
    const value = resultScalars(object, [key])[key]
    if (value !== undefined && (target === 'nativeEventSeq' ? !Number.isSafeInteger(value) || (value as number) < 0 : typeof value !== 'string' || !value)) throw new TypeError('Invalid result identity: ' + key)
    if (value !== undefined) result[target] = value
  }
  if (type === 'context/result-ref') {
    result.legacyResult = legacyResultMetadata(data(event, 'ref'))
  }
  if (typeof type === 'string' && type.startsWith('code/')) {
    for (const key of ['cellId', 'parentCallId']) copy(key, event, key)
    copy('cellSessionId', event, 'sessionId'); copy('cellState', event, 'state')
    copy('nativeCallId', event, 'callId'); copy('nativeName', event, 'name'); copy('nativeEventSeq', event, 'eventSeq')
  }
  if (type === 'subagent/start' || type === 'subagent/end') {
    copy('taskId', event, 'taskId'); copy('taskOutcome', event, 'outcome'); copy('resultRevision', event, 'resultRevision')
  }
  const job = type === 'job/status' ? data(event, 'job') : undefined
  if (job) {
    copy('jobId', job, 'jobId'); copy('jobStatus', job, 'status'); copy('resultRevision', data(job, 'result'), 'revision')
  }
  const envelope = type === 'job/status' ? data(data(job, 'result'), 'envelope') : ['tool/result', 'code/result', 'code/output', 'subagent/end'].includes(type as string) ? data(event, 'envelope') : undefined
  if (envelope) result.resultExecution = resultScalars(data(envelope, 'execution'), ['outcome', 'dispatch'])
  return result as ResultFactMetadata
}
