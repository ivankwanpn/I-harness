import { stringifyJsonData } from '../serialization/json-data.ts'
import type { ResultEnvelope } from './types.ts'
import type { SessionEventView } from '../managed/types.ts'
import type { ManagedArtifactRef } from './types.ts'

export function resultText(envelope: ResultEnvelope): string {
  if (envelope.retention.kind === 'inline' && !envelope.dependencies) return stringifyJsonData(envelope.retention.value) ?? 'null'
  return stringifyJsonData({ version: envelope.version, execution: envelope.execution, preview: envelope.preview, retention: envelope.retention, ...(envelope.dependencies ? { dependencies: envelope.dependencies } : {}) })!
}
export function resultIsError(envelope: ResultEnvelope): boolean { return envelope.execution.outcome !== 'succeeded' }
export function resultDisposition(envelope: ResultEnvelope): 'unknown' | 'not-dispatched' | undefined {
  return envelope.execution.dispatch === 'not-dispatched' ? 'not-dispatched'
    : envelope.execution.dispatch === 'unknown' || envelope.execution.outcome === 'unknown' ? 'unknown' : undefined
}
/** Only closed actual result slots create reference dependencies. */
export function managedResultRefs(event: SessionEventView): readonly ManagedArtifactRef[] {
  const envelope = event.type === 'job/status' ? event.job.result?.kind === 'retained' ? event.job.result.envelope : undefined
    : event.type === 'tool/result' || event.type === 'code/result' || event.type === 'subagent/end' ? event.envelope : undefined
  if (!envelope) return []
  return [...(envelope.retention.kind === 'artifact' ? [envelope.retention.ref] : []), ...(envelope.dependencies?.kind === 'artifact-set' ? [envelope.dependencies.ref] : [])]
}
