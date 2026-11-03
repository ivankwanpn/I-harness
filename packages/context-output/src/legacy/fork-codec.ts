import { createHash } from 'node:crypto'
import { streamJsonData, captureBootstrapPreparationFacts, canonicalJsonData, validateResultsSummary } from '@i-harness/core-session'
import type { ContextResultRef } from '../types.ts'
import { identity } from '../config.ts'
import { types } from 'node:util'
import type { LegacyBindingV1, LegacyBindingV2, LegacyPageV1, LegacyPageV2, LegacyRootV1, LegacyRootV2, LegacyAppliedV1, LegacyAppliedV2, LegacyBinding, LegacyCommitment, LegacyPage, LegacyPageRef, LegacyRoot, LegacyApplied, LegacyRow, LegacyAnchor } from './fork-types.ts'

export function fail(): never { throw new TypeError('Invalid legacy fork metadata') }
export function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key) || !descriptors[key]?.enumerable || !('value' in descriptors[key]!) || descriptors[key]!.value === undefined) || required.some(key => !Object.hasOwn(value, key))) fail()
}
export const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const legacyExpiry = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER
export const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
export function data(value: unknown): void {
  const stack = [value], ancestors = new Set<object>()
  // Persisted records are bounded; this walk validates before any discriminant.
  function check(v: unknown): void {
    if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return
    if (!v || typeof v !== 'object' || ancestors.has(v)) fail()
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || Reflect.ownKeys(v).length !== v.length + 1) fail()
      ancestors.add(v)
      for (let i = 0; i < v.length; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d?.enumerable || !('value' in d)) fail(); check(d.value) }
    } else {
      fields(v, Object.keys(v)); ancestors.add(v)
      for (const d of Object.values(Object.getOwnPropertyDescriptors(v))) check(d.value)
    }
    ancestors.delete(v)
  }
  for (const v of stack) check(v)
}
export function streamHash(domain: string, value: unknown): { digest: string; bytes: number } {
  const h = createHash('sha256').update(domain + '\0'); let bytes = 0
  for (const chunk of streamJsonData(value, { lexical: true, dataOnly: true })) { h.update(chunk); bytes += Buffer.byteLength(chunk); if (!Number.isSafeInteger(bytes)) fail() }
  return { digest: h.digest('hex'), bytes }
}
export const recordHash = (kind: 'binding' | 'page' | 'plan' | 'applied' | 'disposition', value: unknown,version:1|2=1) => streamHash(`ih.legacy-fork.${kind}.v${version}`, value).digest
/** Immutable publication uses lexical bytes independent of host property order.
 * This wrapper applies only to bounded records, never full ref descriptors. */
export function canonicalRecord<T>(value: T): T {
  if (streamHash('ih.legacy-fork.encoded-size.v1', value).bytes > 65536) fail()
  return JSON.parse(canonicalJsonData(value)) as T
}
export const sourceHash = (source: string) => { if (typeof source !== 'string' || !source) fail(); return streamHash('ih.legacy-fork.target-source.v1', source).digest }
export function commitment(ref: ContextResultRef): LegacyCommitment {
  fields(ref, ['id', 'workspaceId', 'sessionId', 'callId', 'label', 'revision', 'bytes', 'originalBytes', 'complete', 'expiresAt'], ['source'])
  if (!/^ctx_[a-f0-9]{64}$/.test(ref.id) || !hash(ref.revision) || !count(ref.bytes) || !count(ref.originalBytes) || ref.originalBytes < ref.bytes || typeof ref.complete !== 'boolean' || !legacyExpiry(ref.expiresAt) || typeof ref.label !== 'string') fail()
  for (const id of [ref.workspaceId, ref.sessionId, ref.callId]) identity(id, 'legacy identity')
  if (ref.source !== undefined) {
    fields(ref.source, ['sourceId'], ['path', 'revision', 'readonly'])
    if (typeof ref.source.sourceId !== 'string' || !ref.source.sourceId || ref.source.path !== undefined && typeof ref.source.path !== 'string' || ref.source.revision !== undefined && typeof ref.source.revision !== 'string' || ref.source.readonly !== undefined && typeof ref.source.readonly !== 'boolean') fail()
  }
  const encoded = streamHash('ih.legacy-ref.metadata.v1', ref)
  return { refId: ref.id, revision: ref.revision, metadataDigest: encoded.digest, metadataEncodedBytes: encoded.bytes, expiresAt: ref.expiresAt }
}
export const same = (a: unknown, b: unknown) => streamHash('ih.legacy-fork.compare.v1', a).digest === streamHash('ih.legacy-fork.compare.v1', b).digest
export function checkCommitment(c: LegacyCommitment): void {
  if (!/^ctx_[a-f0-9]{64}$/.test(c.refId) || !hash(c.revision) || !hash(c.metadataDigest) || !count(c.metadataEncodedBytes) || !legacyExpiry(c.expiresAt)) fail()
}
export function checkAnchor(a: LegacyAnchor, total: number, unframed: boolean, extent: LegacyRow['extent'], groupCount?: number,version:1|2=1,results?:import('@i-harness/core-session').ResultsSummaryV1): void {
  fields(extent, ['kind'], extent.kind === 'framed' ? ['first', 'last'] : [])
  if (extent.kind === 'framed') { if (!count(extent.first) || !count(extent.last) || extent.first < 1 || extent.last < extent.first || extent.last > total) fail() }
  else if (extent.kind !== 'unframed' || !unframed) fail()
  if(version===2){fields(a,['kind','manifestSeq','pageOrdinal','rowOrdinal']);if(a.kind!=='seed-result'||a.manifestSeq!==0||!count(a.pageOrdinal)||!count(a.rowOrdinal)||!results||a.pageOrdinal>=results.pages||a.rowOrdinal>=results.rows)fail();return}
  fields(a, ['kind'], a.kind === 'manifest' ? ['seq'] : ['manifestSeq', 'ordinal'])
  if (a.kind === 'manifest' ? a.seq !== 0 || extent.kind !== 'unframed' : a.kind !== 'seed-group' || a.manifestSeq !== 0 || !count(a.ordinal) || groupCount !== undefined && a.ordinal >= groupCount) fail()
}
export function checkBinding(b: unknown, version?:1): LegacyBindingV1
export function checkBinding(b: unknown, version:2): LegacyBindingV2
export function checkBinding(b: unknown, version:1|2): LegacyBinding
export function checkBinding(b: unknown,version:1|2=1): LegacyBinding {
  data(b); fields(b, ['workspaceId', 'invocation', 'manifestDigest', 'sourceSessionId', 'targetSessionId', 'targetDocumentId', 'semanticSeedDigest', 'sourceObservationDigest', 'selection', 'targetSourceDigest', 'turnDomainDigest', 'totalTurns', 'unframedPrefix',...(version===2?['selectedResults']:[])])
  if(version===2)validateResultsSummary(b.selectedResults)
  for (const id of [b.workspaceId, b.sourceSessionId, b.targetSessionId, b.targetDocumentId]) identity(id, 'legacy binding')
  if (![b.manifestDigest, b.semanticSeedDigest, b.sourceObservationDigest, b.targetSourceDigest, b.turnDomainDigest].every(hash) || !count(b.totalTurns) || typeof b.unframedPrefix !== 'boolean' || b.targetDocumentId !== b.targetSessionId || b.targetSessionId !== b.invocation.targetSessionId) fail()
  captureBootstrapPreparationFacts({ version: 1, invocation: b.invocation, manifestDigest: b.manifestDigest, seedDigest: b.semanticSeedDigest, sourceObservation: { kind: 'none' }, groupCount: 0 })
  fields(b.selection, ['kind'], ['atSeq']); if (b.selection.kind !== 'completed' || b.selection.atSeq !== undefined && !count(b.selection.atSeq)) fail()
  return b as LegacyBinding
}
export function checkPageRef(p: LegacyPageRef): void {
  fields(p, ['digest', 'firstRow', 'rows', 'level']); if (!hash(p.digest) || !count(p.firstRow) || !count(p.rows) || !p.rows || !count(p.level) || !Number.isSafeInteger(p.firstRow + p.rows)) fail()
}
export function checkPage(value:unknown,binding:LegacyBinding,groupCount?:number,version?:1): LegacyPageV1
export function checkPage(value:unknown,binding:LegacyBinding,groupCount: number|undefined,version:2): LegacyPageV2
export function checkPage(value:unknown,binding:LegacyBinding,groupCount: number|undefined,version:1|2): LegacyPage
export function checkPage(value: unknown, binding: LegacyBinding, groupCount?: number,version:1|2=1): LegacyPage {
  data(value); const p = value as LegacyPage
  fields(p, ['version', 'kind', 'bindingDigest', ...(p.kind === 'legacy-fork-leaf' ? ['firstRow', 'rows'] : ['level', 'children'])])
  if (p.version !== version || p.bindingDigest !== recordHash('binding', binding,version) || Buffer.byteLength(JSON.stringify(p)) > 65536) fail()
  if (p.kind === 'legacy-fork-leaf') {
    if (!count(p.firstRow) || !Array.isArray(p.rows) || p.rows.length < 1 || p.rows.length > 100) fail()
    for (const r of p.rows) {
      fields(r, ['refId', 'revision', 'metadataDigest', 'metadataEncodedBytes', 'expiresAt', 'extent', 'anchor', 'original'], ['via']); checkCommitment(r as LegacyRow); checkAnchor(r.anchor, binding.totalTurns, binding.unframedPrefix, r.extent, groupCount,version,binding.selectedResults)
      fields(r.original, ['sessionId', 'seq', 'part']); identity(r.original.sessionId, 'legacy original'); if (!count(r.original.seq) || r.original.part !== 'context/result-ref.ref') fail()
      if (r.via !== undefined) { fields(r.via, ['sessionId', 'operationId', 'manifestDigest', 'planDigest', 'rowOrdinal']); identity(r.via.sessionId, 'legacy via'); identity(r.via.operationId, 'legacy operation'); if (!hash(r.via.manifestDigest) || !hash(r.via.planDigest) || !count(r.via.rowOrdinal)) fail() }
    }
  } else {
    if (p.kind !== 'legacy-fork-directory' || !count(p.level) || p.level < 1 || !Array.isArray(p.children) || !p.children.length || p.children.length > 100) fail()
    let end = p.children[0]!.firstRow
    for (const child of p.children) { checkPageRef(child); if (child.level !== p.level - 1 || child.firstRow !== end) fail(); end += child.rows; if (!Number.isSafeInteger(end)) fail() }
  }
  return p
}
export function checkRoot<T extends {version:1|2}>(value:T): Extract<LegacyRoot,{version:T['version']}>
export function checkRoot(value:unknown): LegacyRoot
export function checkRoot(value: unknown): LegacyRoot {
  data(value); fields(value, ['version', 'kind', 'binding', 'observationCount', 'distinctRefCount', 'pages'])
  const r = value as LegacyRoot;if(r.version!==1&&r.version!==2)fail();checkBinding(r.binding,r.version)
  if ( r.kind !== 'legacy-fork-plan' || !count(r.observationCount) || !count(r.distinctRefCount) || r.distinctRefCount > r.observationCount || Buffer.byteLength(JSON.stringify(r)) > 65536) fail()
  if (r.pages === null) { if (r.observationCount !== 0 || r.distinctRefCount !== 0) fail() }
  else { checkPageRef(r.pages); if (r.pages.firstRow !== 0 || r.pages.rows !== r.observationCount) fail() }
  return r
}
export function appliedFor(root:LegacyRootV1):LegacyAppliedV1
export function appliedFor(root:LegacyRootV2):LegacyAppliedV2
export function appliedFor(root:LegacyRoot):LegacyApplied
export function appliedFor(root:LegacyRoot):LegacyApplied {
 const fields={kind:'legacy-fork-applied' as const,bindingDigest:recordHash('binding',root.binding,root.version),planDigest:recordHash('plan',root,root.version),observationCount:root.observationCount,distinctRefCount:root.distinctRefCount}
 return root.version===1?canonicalRecord({version:1,...fields}):canonicalRecord({version:2,...fields})
}
