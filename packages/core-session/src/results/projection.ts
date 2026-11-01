import { stringifyJsonData } from '../serialization/json-data.ts'
import type { ResultEnvelope } from './types.ts'
import type { SessionEventView } from '../managed/types.ts'
import type { ManagedArtifactRef } from './types.ts'
import type { ManagedResultObservation } from '../conversation/selected-results-types.ts'
import { resultData as data, resultScalars, closedResultMetadata } from './metadata.ts'
import { validManagedArtifactRef } from './validate.ts'
import { validExecDeliveryEvent } from '../events/exec-delivery.ts'
import { validWorkflowDeliveryEvent, workflowTerminalRef } from '../events/workflow-delivery.ts'
import { validCodeDeliveryEvent, codeTerminalRef } from '../events/code-delivery.ts'

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
  if (data(event,'type') === 'code/end') {
    if (!validCodeDeliveryEvent(event) || event.type !== 'code/end') throw new TypeError('Invalid Code result reference')
    const ref=codeTerminalRef(event)
    return ref ? [ref] : []
  }
  if (data(event, 'type') === 'workflow/end') {
    if (!validWorkflowDeliveryEvent(event) || event.type !== 'workflow/end') throw new TypeError('Invalid Workflow result reference')
    const ref = workflowTerminalRef(event)
    return ref ? [ref] : []
  }
  // Required delivery authority is never a semantic seed slot. Its actual
  // original frame dependency still grants local/cold result-read membership.
  if (data(event, 'type') === 'exec/end') {
    if (!validExecDeliveryEvent(event) || event.type !== 'exec/end') throw new TypeError('Invalid Exec result dependency')
    return 'dependency' in event && event.dependency.retention.kind === 'artifact' ? [event.dependency.retention.ref] : []
  }
  return managedResultSlots(event).map(slot => slot.ref)
}
/** Injective event × actual ref-slot observations, before physical deduplication. */
export function managedResultSlots(event: SessionEventView): readonly ManagedResultObservation[] {
  const type = data(event, 'type')
  if (!['tool/result', 'code/result', 'code/output', 'subagent/end', 'job/status'].includes(type as string)) return []
  const jobResult = type === 'job/status' ? data(data(event, 'job'), 'result') : undefined
  const envelope = type === 'job/status' ? data(jobResult, 'kind') === 'retained' ? data(jobResult, 'envelope') : undefined : data(event, 'envelope')
  if (!envelope) return []
  const observations: ManagedResultObservation[] = []
  const retention = data(envelope, 'retention'), dependencies = data(envelope, 'dependencies')
  const add = (suffix: 'retention.ref' | 'dependencies.ref', value: unknown, use: ManagedResultObservation['use']) => {
    closedResultMetadata(value, ['version', 'id', 'revision', 'codec', 'encodedBytes', 'contentDigest', 'completeness'])
    const ref = resultScalars(value, ['version', 'id', 'revision', 'codec', 'encodedBytes', 'contentDigest', 'completeness'])
    if (!validManagedArtifactRef(ref)) throw new TypeError('Invalid managed result ref')
    const address = type === 'job/status' ? { event: type, slot: `job.result.envelope.${suffix}` } : { event: type, slot: `envelope.${suffix}` }
    observations.push({ address: address as ManagedResultObservation['address'], ref, use })
  }
  if (data(retention, 'kind') === 'artifact') add('retention.ref', data(retention, 'ref'), { kind: 'result' })
  if (data(dependencies, 'kind') === 'artifact-set') {
    const count = data(dependencies, 'count')
    if (!Number.isSafeInteger(count) || (count as number) < 1) throw new TypeError('Invalid dependency count')
    add('dependencies.ref', data(dependencies, 'ref'), { kind: 'dependency-catalog', count: count as number })
  }
  return observations
}
