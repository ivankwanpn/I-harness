import { types } from 'node:util'
import { canonicalJsonData, validManagedArtifactRef, type BootstrapDependencyRequest } from '@i-harness/core-session'
import type { ContextAccess, ContextCapture } from '../types.ts'
import { identity } from '../config.ts'
import { isMetadataData } from './metadata-data.ts'
import type { ArtifactOwner } from './types.ts'

export interface SeedDependencyTransferScope { readonly kind: 'seed-dependency-transfer' }
export interface SeedDependencyTransferBinding {
  operationId: string; manifestDigest: string; sourceSessionId: string; targetSessionId: string; targetDocumentId: string
}
export interface SeedDependencyHostAccess {
  binding: SeedDependencyTransferBinding; sourceAccess: ContextAccess;
  sourceAvailable(): boolean; assertSourceCurrent(): void; targetAvailable(): boolean;
  targetScope(): { source: NonNullable<ContextCapture['source']>; revision: string }; assertTargetCurrent(): void;
}
export class TransferBlocked extends Error {
  constructor(readonly reason: 'unknown' | 'unavailable' | 'conflict' | 'policy', message = 'Seed dependency transfer ' + reason) { super(message) }
}
export function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TransferBlocked('conflict')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key) || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))
    || required.some(key => !Object.hasOwn(descriptors, key))) throw new TransferBlocked('conflict')
}
export function validTransferBinding(value: unknown): value is SeedDependencyTransferBinding {
  try {
    fields(value, ['operationId', 'manifestDigest', 'sourceSessionId', 'targetSessionId', 'targetDocumentId'])
    if (!isMetadataData(value) || typeof value.manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestDigest)) return false
    for (const key of ['operationId', 'sourceSessionId', 'targetSessionId', 'targetDocumentId']) {
      identity(value[key] as string, key)
      if ((value[key] as string).length > 256) return false
    }
    return value.targetDocumentId === value.targetSessionId
  } catch { return false }
}
export function captureHost(value: SeedDependencyHostAccess): SeedDependencyHostAccess {
  fields(value, ['binding', 'sourceAccess', 'sourceAvailable', 'assertSourceCurrent', 'targetAvailable', 'targetScope', 'assertTargetCurrent'])
  if (!validTransferBinding(value.binding)) throw new TransferBlocked('conflict')
  fields(value.sourceAccess, ['sessionId'], ['signal'])
  if (value.sourceAccess.sessionId !== value.binding.sourceSessionId || value.sourceAccess.signal !== undefined && (types.isProxy(value.sourceAccess.signal) || !(value.sourceAccess.signal instanceof AbortSignal))) throw new TransferBlocked('conflict')
  for (const key of ['sourceAvailable', 'assertSourceCurrent', 'targetAvailable', 'targetScope', 'assertTargetCurrent'] as const) if (typeof value[key] !== 'function' || types.isProxy(value[key])) throw new TransferBlocked('conflict')
  const { operationId, manifestDigest, sourceSessionId, targetSessionId, targetDocumentId } = value.binding
  return Object.freeze({ binding: Object.freeze({ operationId, manifestDigest, sourceSessionId, targetSessionId, targetDocumentId }), sourceAccess: Object.freeze({ ...value.sourceAccess }), sourceAvailable: value.sourceAvailable,
    assertSourceCurrent: value.assertSourceCurrent, targetAvailable: value.targetAvailable, targetScope: value.targetScope, assertTargetCurrent: value.assertTargetCurrent })
}
export function captureTarget(value: ReturnType<SeedDependencyHostAccess['targetScope']>): string {
  fields(value, ['source', 'revision']); fields(value.source, ['sourceId'], ['path', 'revision', 'readonly'])
  if (!isMetadataData(value)) throw new TransferBlocked('policy')
  identity(value.revision, 'target revision'); identity(value.source.sourceId, 'target source')
  if (value.source.path !== undefined && typeof value.source.path !== 'string' || value.source.revision !== undefined && typeof value.source.revision !== 'string' || value.source.readonly !== undefined && typeof value.source.readonly !== 'boolean') throw new TransferBlocked('policy')
  return canonicalJsonData(value)
}
export function validOwner(value: unknown): value is ArtifactOwner {
  try {
    fields(value, ['operationId', 'sessionId', 'callId'], ['documentId', 'source'])
    if (!isMetadataData(value)) return false
    for (const key of ['operationId', 'sessionId', 'callId']) identity(value[key] as string, key)
    if (value.documentId !== undefined) identity(value.documentId as string, 'documentId')
    if (value.source !== undefined) captureTarget({ source: value.source as NonNullable<ContextCapture['source']>, revision: 'owner-validation' })
    return true
  } catch { return false }
}
/** Same closed artifact/use/address rules as the seed codec. The request has
 * no origin table or groups, so it cannot claim to validate the whole seed. */
export function captureRequest(value: BootstrapDependencyRequest, binding: SeedDependencyTransferBinding): BootstrapDependencyRequest {
  fields(value, ['operationId', 'targetSessionId', 'manifestDigest', 'sourceSessionId', 'artifacts'])
  if (!isMetadataData(value)) throw new TransferBlocked('conflict')
  for (const key of ['operationId', 'targetSessionId', 'manifestDigest', 'sourceSessionId'] as const) if (value[key] !== binding[key]) throw new TransferBlocked('conflict')
  if (!Array.isArray(value.artifacts) || !value.artifacts.length) throw new TransferBlocked('unavailable')
  const identities = new Set<string>(), count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  for (const artifact of value.artifacts) {
    fields(artifact, ['ref', 'origins', 'uses'])
    if (!validManagedArtifactRef(artifact.ref) || identities.has(`${artifact.ref.id}:${artifact.ref.revision}`) || !Array.isArray(artifact.origins) || !Array.isArray(artifact.uses) || !artifact.uses.length) throw new TransferBlocked('conflict')
    identities.add(`${artifact.ref.id}:${artifact.ref.revision}`)
    for (const origin of artifact.origins) { fields(origin, ['origin', 'seq', 'part']); if (!count(origin.origin) || !count(origin.seq) || typeof origin.part !== 'string' || !origin.part.length || Buffer.byteLength(origin.part) > 64) throw new TransferBlocked('conflict') }
    const uses = new Set<string>()
    let catalogCount: number | undefined
    for (const use of artifact.uses) {
      fields(use, use.kind === 'result' ? ['kind'] : ['kind', 'count'])
      if (use.kind !== 'result') {
        if (use.kind !== 'dependency-catalog' || !count(use.count) || !use.count || artifact.ref.codec !== 'json-utf8-v1' || catalogCount !== undefined && catalogCount !== use.count) throw new TransferBlocked('conflict')
        catalogCount = use.count
      }
      const encoded = canonicalJsonData(use); if (uses.has(encoded)) throw new TransferBlocked('conflict'); uses.add(encoded)
    }
  }
  return structuredClone(value)
}
