import { createHash } from 'node:crypto'
import { sameManagedArtifactRef, validManagedArtifactRef, type ManagedArtifactRef } from '@i-harness/core-session'
import type { NativeIdentity, SavedCall } from './saved-process-index.ts'
import type { savedResultDescriptor } from './saved-result-json.ts'
const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined
const closed = (v: unknown, keys: string[]) => !!object(v) && Object.keys(v as object).length === keys.length && Object.keys(v as object).every(k => keys.includes(k))
const size = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
type Descriptor = NonNullable<ReturnType<typeof savedResultDescriptor>>
/** Comparison proof only. The supplied reader retains all original authorization. */
export function captureSavedBinding(descriptor: Descriptor, selected: NativeIdentity, call: SavedCall): Record<string, any> {
  if (!call || call.provenance !== 'artifact' || call.name !== 'job_output' || !call.descriptor || !sameManagedArtifactRef(call.descriptor.dto, descriptor.dto)
    || !descriptor.catalog || !call.descriptor.catalog || !sameManagedArtifactRef(call.descriptor.catalog, descriptor.catalog)) throw new Error('Original artifact observation required')
  const args = object(structuredClone(call.args))
  if (!args || args.job_id !== selected.jobId || args.job_instance_id !== selected.instanceId || args.source_id !== undefined && args.source_id !== selected.sourceId
    || args.offset_bytes !== undefined && args.offset_bytes !== 0 || args.digest !== undefined && !hash(args.digest)
    || ['cursor', 'body', 'result_revision', 'ref_revision', 'ref_id'].some(k => args[k] !== undefined) || args.field !== undefined && args.field !== 'text') throw new Error('Original call selectors mismatch')
  return args
}
export function validateSavedOutput(value: Record<string, any>, identity: NativeIdentity, args: Record<string, any>, catalog: unknown): void {
  const n = object(value.native_job), full = object(value.full_result), entryCatalog = object(catalog)
  if (value.job_id !== identity.jobId || !n || n.version !== 1 || n.jobId !== identity.jobId || n.instanceId !== identity.instanceId || n.ownerSessionId !== identity.ownerSessionId || n.sourceId !== identity.sourceId) throw new Error('DTO identity mismatch')
  if (!entryCatalog || !closed(entryCatalog, ['version', 'kind', 'entries']) || entryCatalog.version !== 1 || entryCatalog.kind !== 'result-dependencies' || !Array.isArray(entryCatalog.entries) || entryCatalog.entries.length !== 1) throw new Error('Invalid dependency catalog')
  const entry = entryCatalog.entries[0]
  if (!closed(entry, ['kind', 'sourceId', 'retention']) || entry.kind !== 'exec-frames' || entry.sourceId !== identity.sourceId) throw new Error('Catalog source mismatch')
  const retention = object(entry.retention)
  if (retention?.kind === 'unavailable') {
    if (!['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled'].includes(retention.reason) || Object.keys(retention).some(k => !['kind', 'reason', 'observedEncodedBytes'].includes(k)) || retention.observedEncodedBytes !== undefined && !size(retention.observedEncodedBytes)) throw new Error('Invalid unavailable dependency')
    throw new Error('Native source unavailable: ' + retention.reason)
  }
  if (!closed(retention, ['kind', 'ref']) || retention!.kind !== 'artifact' || !validManagedArtifactRef(retention!.ref) || retention!.ref.codec !== 'exec-frames-v1' || !['complete', 'source-limited'].includes(retention!.ref.completeness)) throw new Error('Unsupported native retention')
  const frame = retention!.ref as ManagedArtifactRef
  if (!full || !closed(full, ['tool', 'args', 'access', 'catalog_from']) || full.tool !== 'context_output_read' || full.access !== 'catalog-required' || full.catalog_from !== 'envelope.dependencies.ref'
    || !closed(full.args, ['ref', 'maxBytes']) || full.args.maxBytes !== 32768 || !validManagedArtifactRef(full.args.ref) || !sameManagedArtifactRef(frame, full.args.ref)) throw new Error('Full result/catalog mismatch')
  if (value.source?.kind !== 'retained-summary' || value.scope !== 'captured' || value.completeness !== frame.completeness || value.digest_format !== 'sha256-raw-v1'
    || !size(value.total_bytes) || !size(value.stderr_total_bytes) || !size(value.total_raw_bytes) || !Number.isSafeInteger(value.total_bytes + value.stderr_total_bytes) || value.total_raw_bytes !== value.total_bytes + value.stderr_total_bytes
    || !hash(value.digest) || !hash(value.stderr_digest) || args.digest !== undefined && args.digest !== value.digest) throw new Error('Native summary mismatch')
  if ('error' in value || value.display_only !== undefined || typeof value.text !== 'string' || typeof value.truncated !== 'boolean' || value.offset_bytes !== 0 || !size(value.next_offset_bytes)
    || value.next_offset_bytes !== Buffer.byteLength(value.text, 'utf8') || value.next_offset_bytes > value.total_bytes || value.truncated !== (value.next_offset_bytes < value.total_bytes || value.completeness !== 'complete')) throw new Error('Unsupported native snapshot')
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
  if (value.next_offset_bytes === value.total_bytes && sha(value.text) !== value.digest || value.stderr_total_bytes === 0 && sha('') !== value.stderr_digest) throw new Error('Native snapshot digest mismatch')
}
