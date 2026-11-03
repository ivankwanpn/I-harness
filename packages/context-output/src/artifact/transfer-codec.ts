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
export type SeedDependencyTargetScope = {source:NonNullable<ContextCapture['source']>;revision:string}
export interface ExistingSeedDependencyHostAccess {
  binding: SeedDependencyTransferBinding; sourceAccess: ContextAccess;
  sourceAvailable(): boolean; assertSourceCurrent(): void; targetAvailable(): boolean;
  targetScope(): SeedDependencyTargetScope; assertTargetCurrent(): void;
}
/** Active observes both source and target; passive observes only target. */
export interface CoherentSeedDependencyHostAccess {
  kind:'coherent-observation-v1';binding:SeedDependencyTransferBinding;sourceAccess:ContextAccess;
  observeCurrent(mode:'active'|'passive'):SeedDependencyTargetScope;
}
export type SeedDependencyHostAccess = ExistingSeedDependencyHostAccess|CoherentSeedDependencyHostAccess
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
  if(!value||typeof value!=='object'||types.isProxy(value))throw new TransferBlocked('conflict')
  const kind=Object.getOwnPropertyDescriptor(value,'kind')
  if(kind){
    fields(value,['kind','binding','sourceAccess','observeCurrent'])
    if(value.kind!=='coherent-observation-v1'||!validTransferBinding(value.binding))throw new TransferBlocked('conflict')
    fields(value.sourceAccess,['sessionId'],['signal'])
    if(value.sourceAccess.sessionId!==value.binding.sourceSessionId||value.sourceAccess.signal!==undefined&&(types.isProxy(value.sourceAccess.signal)||!(value.sourceAccess.signal instanceof AbortSignal)))throw new TransferBlocked('conflict')
    const descriptor=Object.getOwnPropertyDescriptor(value,'observeCurrent')!,observer=descriptor.value as CoherentSeedDependencyHostAccess['observeCurrent']
    if(typeof observer!=='function'||types.isProxy(observer))throw new TransferBlocked('conflict')
    const originalBinding=value.binding,originalAccess=value.sourceAccess,hostDescriptors=Object.getOwnPropertyDescriptors(value),bindingDescriptors=Object.getOwnPropertyDescriptors(originalBinding),accessDescriptors=Object.getOwnPropertyDescriptors(originalAccess)
    const {operationId,manifestDigest,sourceSessionId,targetSessionId,targetDocumentId}=originalBinding
    const checkDescriptors=(object:object,original:PropertyDescriptorMap,keys:readonly string[])=>{
      if(Reflect.ownKeys(object).length!==keys.length)throw new TransferBlocked('policy')
      for(const key of keys){const before=original[key],after=Object.getOwnPropertyDescriptor(object,key);if(!before||!after||!('value'in before)||!('value'in after)||after.value!==before.value||after.enumerable!==before.enumerable||after.configurable!==before.configurable||after.writable!==before.writable)throw new TransferBlocked('policy')}
    }
    const hostKeys=['kind','binding','sourceAccess','observeCurrent'],bindingKeys=['operationId','manifestDigest','sourceSessionId','targetSessionId','targetDocumentId'],accessKeys=Object.hasOwn(accessDescriptors,'signal')?['sessionId','signal']:['sessionId']
    const checkOriginal=()=>{fields(value,hostKeys);fields(originalBinding,bindingKeys);fields(originalAccess,['sessionId'],['signal']);checkDescriptors(value,hostDescriptors,hostKeys);checkDescriptors(originalBinding,bindingDescriptors,bindingKeys);checkDescriptors(originalAccess,accessDescriptors,accessKeys)}
    let entered=false,violated=false
    return Object.freeze({kind:'coherent-observation-v1' as const,binding:Object.freeze({operationId,manifestDigest,sourceSessionId,targetSessionId,targetDocumentId}),sourceAccess:Object.freeze({...originalAccess}),observeCurrent(mode:'active'|'passive'){
      if(entered){violated=true;throw new TransferBlocked('policy')}
      if(violated)throw new TransferBlocked('policy')
      checkOriginal();entered=true
      try{const result=Reflect.apply(observer,value,[mode]);if(types.isPromise(result)){void Promise.prototype.then.call(result,undefined,()=>{});throw new TransferBlocked('policy')}checkOriginal();if(violated)throw new TransferBlocked('policy');return result}
      finally{entered=false}
    }})
  }
  fields(value, ['binding', 'sourceAccess', 'sourceAvailable', 'assertSourceCurrent', 'targetAvailable', 'targetScope', 'assertTargetCurrent'])
  if (!validTransferBinding(value.binding)) throw new TransferBlocked('conflict')
  fields(value.sourceAccess, ['sessionId'], ['signal'])
  if (value.sourceAccess.sessionId !== value.binding.sourceSessionId || value.sourceAccess.signal !== undefined && (types.isProxy(value.sourceAccess.signal) || !(value.sourceAccess.signal instanceof AbortSignal))) throw new TransferBlocked('conflict')
  for (const key of ['sourceAvailable', 'assertSourceCurrent', 'targetAvailable', 'targetScope', 'assertTargetCurrent'] as const) if (typeof value[key] !== 'function' || types.isProxy(value[key])) throw new TransferBlocked('conflict')
  const legacy=value as ExistingSeedDependencyHostAccess
  const { operationId, manifestDigest, sourceSessionId, targetSessionId, targetDocumentId } = legacy.binding
  return Object.freeze({ binding: Object.freeze({ operationId, manifestDigest, sourceSessionId, targetSessionId, targetDocumentId }), sourceAccess: Object.freeze({ ...legacy.sourceAccess }), sourceAvailable: legacy.sourceAvailable,
    assertSourceCurrent: legacy.assertSourceCurrent, targetAvailable: legacy.targetAvailable, targetScope: legacy.targetScope, assertTargetCurrent: legacy.assertTargetCurrent })
}
export function captureTarget(value: SeedDependencyTargetScope): string {
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
export function captureRequest(value: BootstrapDependencyRequest, binding: SeedDependencyTransferBinding, allowEmpty = false): BootstrapDependencyRequest {
  fields(value, ['operationId', 'targetSessionId', 'manifestDigest', 'sourceSessionId', 'artifacts'])
  if (!isMetadataData(value)) throw new TransferBlocked('conflict')
  for (const key of ['operationId', 'targetSessionId', 'manifestDigest', 'sourceSessionId'] as const) if (value[key] !== binding[key]) throw new TransferBlocked('conflict')
  if (!Array.isArray(value.artifacts) || !allowEmpty && !value.artifacts.length) throw new TransferBlocked('unavailable')
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
