import { validateImages } from '../images.ts'
import { stringifyJsonData } from '../serialization/json-data.ts'
import type { ManagedArtifactRef, ResultEnvelope, RetainedResultRevision } from './types.ts'

const utf8 = new TextEncoder()
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const size = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const completeness = ['complete', 'source-limited', 'capture-canceled', 'producer-incomplete']
const codecs = ['json-utf8-v1', 'text-utf8-v1', 'exec-frames-v1']

/** Accessor-free, iterative closed-data preflight, independent of legacy JSON. */
function data(input: unknown): boolean {
  const ancestors = new Set<object>(), work: ({ value: unknown } | { leave: object })[] = [{ value: input }]
  while (work.length) {
    const entry = work.pop()!
    if ('leave' in entry) { ancestors.delete(entry.leave); continue }
    const value = entry.value
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue
    if (typeof value === 'number') { if (!Number.isFinite(value)) return false; continue }
    if (typeof value !== 'object' || ancestors.has(value)) return false
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype) return false
    const fields = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) return false
    ancestors.add(value); work.push({ leave: value })
    for (const [key, field] of Object.entries(fields)) {
      if (!('value' in field)) return false
      if (array && key === 'length') continue
      if (!field.enumerable) return false
      work.push({ value: field.value })
    }
    if (array && Object.keys(fields).length !== value.length + 1) return false
  }
  return true
}
const closed = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))

/** Package-private semantic-source metadata validation. Retained inline value,
 * preview and media bytes are deliberately outside this structural profile. */
export function validateResultSourceMetadata(event: object, formatVersion: number): void {
  const descriptor = Object.getOwnPropertyDescriptor(event, 'envelope')
  if (!descriptor) return
  if (formatVersion < 10 || !('value' in descriptor) || !descriptor.enumerable || 'output' in event || 'isError' in event) throw new TypeError('Invalid result metadata')
  const envelope = descriptor.value as ResultEnvelope
  const fields = (value: unknown, keys: string[], opaque: string[] = []) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid result metadata')
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !opaque.includes(key) && !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) throw new TypeError('Invalid result metadata')
  }
  fields(envelope, ['version', 'execution', 'preview', 'media', 'retention', 'dependencies'], ['preview'])
  fields(envelope.execution, ['outcome', 'dispatch'])
  if (envelope.version !== 1 || !['succeeded', 'failed', 'canceled', 'unknown'].includes(envelope.execution.outcome)
    || !['dispatched', 'not-dispatched', 'unknown'].includes(envelope.execution.dispatch) || !Array.isArray(envelope.media)) throw new TypeError('Invalid result metadata')
  const retention = envelope.retention
  fields(retention, ['kind', 'value', 'encodedBytes', 'ref', 'reason', 'observedEncodedBytes'], ['value'])
  if (retention.kind === 'inline') {
    fields(retention, ['kind', 'value', 'encodedBytes'], ['value'])
    if (!Object.hasOwn(retention, 'value') || !size(retention.encodedBytes)) throw new TypeError('Invalid result metadata')
  } else if (retention.kind === 'artifact') {
    fields(retention, ['kind', 'ref']); if (!validManagedArtifactRef(retention.ref)) throw new TypeError('Invalid result metadata')
  } else if (retention.kind === 'unavailable') {
    fields(retention, ['kind', 'reason', 'observedEncodedBytes'])
    if (!['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled'].includes(retention.reason)
      || retention.observedEncodedBytes !== undefined && !size(retention.observedEncodedBytes)) throw new TypeError('Invalid result metadata')
  } else throw new TypeError('Invalid result metadata')
  if (envelope.dependencies) {
    const dependency = envelope.dependencies
    fields(dependency, ['kind', 'ref', 'reason', 'count'])
    fields(dependency, dependency.kind === 'artifact-set' ? ['kind', 'ref', 'count'] : ['kind', 'reason', 'count'])
    if (!size(dependency.count) || dependency.count < 1 || (dependency.kind === 'artifact-set' ? !validManagedArtifactRef(dependency.ref) || dependency.ref.codec !== 'json-utf8-v1'
      : dependency.kind !== 'unavailable' || !['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled'].includes(dependency.reason))) throw new TypeError('Invalid result metadata')
  }
}

export function validManagedArtifactRef(value: unknown): value is ManagedArtifactRef {
  if (!data(value) || value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as ManagedArtifactRef
  return closed(ref, ['version', 'id', 'revision', 'codec', 'encodedBytes', 'contentDigest', 'completeness'])
    && ref.version === 1 && typeof ref.id === 'string' && /^ctxv1_[a-f0-9]{64}$/.test(ref.id)
    && hash(ref.revision) && hash(ref.contentDigest) && size(ref.encodedBytes) && codecs.includes(ref.codec) && completeness.includes(ref.completeness)
}

function validResultEnvelope(value: unknown): value is ResultEnvelope {
  try {
    if (!data(value) || value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const result = value as ResultEnvelope, retention = result.retention
    if (!closed(result, ['version', 'execution', 'preview', 'media', 'retention', 'dependencies']) || result.version !== 1
      || !result.execution || !closed(result.execution, ['outcome', 'dispatch'])
      || !['succeeded', 'failed', 'canceled', 'unknown'].includes(result.execution.outcome)
      || !['not-dispatched', 'dispatched', 'unknown'].includes(result.execution.dispatch)
      || typeof result.preview !== 'string' || !Array.isArray(result.media) || !retention) return false
    validateImages(result.media, 'result envelope')
    if (retention.kind === 'inline') {
      if (!closed(retention, ['kind', 'value', 'encodedBytes']) || result.preview !== '' || !size(retention.encodedBytes)
        || utf8.encode(stringifyJsonData(retention.value)).length !== retention.encodedBytes) return false
    } else if (retention.kind === 'artifact') {
      if (!closed(retention, ['kind', 'ref']) || !validManagedArtifactRef(retention.ref)) return false
    } else if (retention.kind === 'unavailable') {
      if (!closed(retention, ['kind', 'reason', 'observedEncodedBytes'])
        || !['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled'].includes(retention.reason)
        || retention.observedEncodedBytes !== undefined && !size(retention.observedEncodedBytes)) return false
    } else return false
    if (result.dependencies !== undefined) {
      const dependency = result.dependencies
      if (!size(dependency.count) || dependency.count < 1) return false
      if (dependency.kind === 'artifact-set') {
        if (!closed(dependency, ['kind', 'ref', 'count']) || !validManagedArtifactRef(dependency.ref) || dependency.ref.codec !== 'json-utf8-v1') return false
      } else if (dependency.kind === 'unavailable') {
        if (!closed(dependency, ['kind', 'reason', 'count']) || !['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled'].includes(dependency.reason)) return false
      } else return false
    }
    // Typed media keeps its separately validated bound and travels separately.
    return utf8.encode(stringifyJsonData({ ...result, media: [] })).length <= 64000
  } catch { return false }
}

export function validRetainedResultRevision(value: unknown): value is RetainedResultRevision {
  if (!data(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as RetainedResultRevision
  if (row.version !== 1 || typeof row.revision !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.revision)) return false
  if (row.kind === 'pending') return closed(row, ['version', 'revision', 'kind'])
  return row.kind === 'retained' && closed(row, ['version', 'revision', 'kind', 'envelope']) && validResultEnvelope(row.envelope)
}

export function validateResultFact(event: object, formatVersion: number): void {
  if (Object.getOwnPropertyDescriptor(event, 'type')?.value === 'job/status') {
    const job = Object.getOwnPropertyDescriptor(event, 'job')
    if (!job || !('value' in job) || !job.value || typeof job.value !== 'object') return
    const result = Object.getOwnPropertyDescriptor(job.value, 'result')
    if (result && (formatVersion < 10 || !('value' in result) || !result.enumerable || !validRetainedResultRevision(result.value))) throw new TypeError('Invalid retained job result or session format')
  }
  const field = Object.getOwnPropertyDescriptor(event, 'envelope')
  const child = Object.getOwnPropertyDescriptor(event, 'type')?.value === 'subagent/end'
  const revision = Object.getOwnPropertyDescriptor(event, 'resultRevision')
  if (child && revision && !field) throw new TypeError('Child result revision requires its envelope')
  if (!field) return
  if (Object.getOwnPropertyDescriptor(event, 'type')?.value === 'code/output' && 'content' in event) throw new TypeError('Code output cannot contain both raw content and a result envelope')
  if (formatVersion < 10 || !('value' in field) || !field.enumerable || 'output' in event || 'isError' in event || !validResultEnvelope(field.value)) throw new TypeError('Invalid result envelope or session format')
  if (child) {
    if (!revision || !('value' in revision) || !revision.enumerable || typeof revision.value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(revision.value)) throw new TypeError('Invalid child result revision')
    const preview: Record<string, string> = {}
    for (const name of ['resultText', 'error']) {
      const value = Object.getOwnPropertyDescriptor(event, name)
      if (!value) continue
      if (!('value' in value) || !value.enumerable || typeof value.value !== 'string') throw new TypeError('Invalid child result preview')
      preview[name] = value.value
    }
    if (utf8.encode(stringifyJsonData(preview)).length > 2048) throw new TypeError('Child result preview exceeds budget')
  }
}
