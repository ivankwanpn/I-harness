import { canonicalJsonData, validateResultsSummary } from '@i-harness/core-session'
import { bootstrapHash } from './semantic-seed.ts'
import { readForkRequestCore } from './fork-contract.ts'
import type { BootstrapCallerMetadata, BootstrapInvocation } from './coordinator/bootstrap-types.ts'
import type { BootstrapProjectIntent } from './coordinator/bootstrap-intent.ts'

const bad = (): never => { throw new TypeError('Invalid selected results fork contract') }
function fields(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad()
  const ds = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value as object).some(k => typeof k !== 'string' || !required.includes(k) && !optional.includes(k)) || required.some(k => !Object.hasOwn(ds,k))) bad()
  const r: Record<string, any> = {}
  for (const [k,d] of Object.entries(ds)) { if (!d.enumerable || !('value' in d) || d.value === undefined) bad(); r[k] = d.value }
  return r
}
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const safeId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\\/\u0000-\u001f\u007f]/.test(v) && !v.includes('..')
const same = (a: unknown,b: unknown) => canonicalJsonData(a) === canonicalJsonData(b)
// V2 snapshots are frozen recursively; keep reused V1 DTOs readonly only here.
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type CompletedSelection = DeepReadonly<{ kind:'completed'; atSeq?:number }>
export type ForkRequestCoreV2 = DeepReadonly<{ version:2; kind:'session-fork-core'; sourceSessionId:string; selection:CompletedSelection; sourceCapture:'first-authorized-capture'; metadata:BootstrapCallerMetadata; results:'selected-results-v1' }>
export type ForkPrepareRequestV2 = DeepReadonly<{ version:2; sourceSessionId:string; selection?:CompletedSelection; metadata?:BootstrapCallerMetadata; results:'selected-results-v1' }>
export type SelectedResultsRequestIntentV2 = DeepReadonly<{ version:2;kind:'selected-results-fork-intent';requestCoreDigest:string;project:BootstrapProjectIntent }>
export type ForkPreparedV2 = DeepReadonly<{version:2;kind:'session-fork-prepared';core:ForkRequestCoreV2;requestIntent:SelectedResultsRequestIntentV2;requestDigest:string}>
export type ForkOperationV2 = DeepReadonly<{version:2;kind:'session-fork-operation';prepared:ForkPreparedV2;invocation:BootstrapInvocation}>
export function readSelectedResultsCore(input: unknown): ForkRequestCoreV2 {
  const r=fields(input,['version','kind','sourceSessionId','selection','sourceCapture','metadata','results'])
  if(r.version!==2 || r.kind!=='session-fork-core' || r.sourceCapture!=='first-authorized-capture' || r.results!=='selected-results-v1') bad()
  const c=readForkRequestCore({version:1,kind:r.kind,sourceSessionId:r.sourceSessionId,selection:r.selection,sourceCapture:r.sourceCapture,metadata:r.metadata})
  return Object.freeze({version:2,kind:'session-fork-core',sourceSessionId:c.sourceSessionId,selection:c.selection,sourceCapture:'first-authorized-capture',metadata:c.metadata,results:'selected-results-v1'})
}
export function readSelectedResultsPrepareRequest(input: unknown): ForkPrepareRequestV2 {
  const r=fields(input,['version','sourceSessionId','results'],['selection','metadata'])
  if(r.version!==2 || r.results!=='selected-results-v1') bad()
  const c=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:r.sourceSessionId,selection:r.selection === undefined ? {kind:'completed'} : r.selection,sourceCapture:'first-authorized-capture',metadata:r.metadata === undefined ? {} : r.metadata,results:r.results})
  return Object.freeze({version:2,sourceSessionId:c.sourceSessionId,results:'selected-results-v1',...(r.selection===undefined?{}:{selection:c.selection}),...(r.metadata===undefined?{}:{metadata:c.metadata})})
}
function project(input: unknown): DeepReadonly<BootstrapProjectIntent> {
  const p=fields(input,['kind'],['projectId'])
  if(p.kind==='project') { fields(input,['kind','projectId']); if(typeof p.projectId!=='string' || !p.projectId || p.projectId.length>256 || /[\u0000-\u001f\u007f]/.test(p.projectId)) bad(); return Object.freeze({kind:'project',projectId:p.projectId}) }
  fields(input,['kind']); if(p.kind!=='unmanaged' && p.kind!=='unassigned') bad(); return Object.freeze({kind:p.kind})
}
export function createSelectedResultsIntent(core: unknown, projectInput: unknown): DeepReadonly<{intent:SelectedResultsRequestIntentV2;requestDigest:string}> {
  const c=readSelectedResultsCore(core), p=project(projectInput)
  const intent:SelectedResultsRequestIntentV2=Object.freeze({version:2,kind:'selected-results-fork-intent',requestCoreDigest:bootstrapHash('ih.bootstrap.selected-results.core.v1',c),project:p})
  return Object.freeze({intent,requestDigest:bootstrapHash('ih.bootstrap.selected-results.request.v1',intent)})
}
export function readSelectedResultsPrepared(input:unknown): ForkPreparedV2 {
  const r=fields(input,['version','kind','core','requestIntent','requestDigest']); if(r.version!==2 || r.kind!=='session-fork-prepared' || !hash(r.requestDigest)) bad()
  const core=readSelectedResultsCore(r.core), i=fields(r.requestIntent,['version','kind','requestCoreDigest','project'])
  const calculated=createSelectedResultsIntent(core,i.project)
  if(i.version!==2 || i.kind!=='selected-results-fork-intent' || i.requestCoreDigest!==calculated.intent.requestCoreDigest || r.requestDigest!==calculated.requestDigest) bad()
  return Object.freeze({version:2,kind:'session-fork-prepared',core,requestIntent:calculated.intent,requestDigest:calculated.requestDigest})
}
export function readSelectedResultsInvocation(input:unknown): DeepReadonly<BootstrapInvocation> {
  const r=fields(input,['version','operationId','targetSessionId','createdAt','requestDigest'])
  if(r.version!==1 || typeof r.operationId!=='string' || !/^[\x21-\x7e]{1,237}$/.test(r.operationId) || !safeId(r.targetSessionId) || !hash(r.requestDigest) || typeof r.createdAt!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.createdAt) || !Number.isFinite(Date.parse(r.createdAt)) || new Date(r.createdAt).toISOString()!==r.createdAt) bad()
  return Object.freeze({version:1,operationId:r.operationId,targetSessionId:r.targetSessionId,createdAt:r.createdAt,requestDigest:r.requestDigest})
}
export function selectedResultsPathKey(input:unknown):string { return bootstrapHash('ih.bootstrap.selected-results.path.v1',readSelectedResultsInvocation(input)) }
export function readSelectedResultsOperation(input:unknown):ForkOperationV2 {
  const r=fields(input,['version','kind','prepared','invocation']); if(r.version!==2 || r.kind!=='session-fork-operation') bad()
  const prepared=readSelectedResultsPrepared(r.prepared), invocation=readSelectedResultsInvocation(r.invocation)
  if(invocation.requestDigest!==prepared.requestDigest || invocation.targetSessionId===prepared.core.sourceSessionId) bad()
  return Object.freeze({version:2,kind:'session-fork-operation',prepared,invocation})
}
export function readSelectedResultsCommand(input:unknown): ForkCommandV2 {
  const r=fields(input,['operation','mode']); if(r.mode!=='begin' && r.mode!=='retry') bad()
  return Object.freeze({operation:readSelectedResultsOperation(r.operation),mode:r.mode as 'begin'|'retry'})
}
export function readSelectedResultsPrepareResult(input:unknown): ForkPrepareResultV2 {
  const r=fields(input,['kind'],['prepared','reason'])
  if(r.kind==='prepared') {fields(input,['kind','prepared']);return Object.freeze({kind:'prepared' as const,prepared:readSelectedResultsPrepared(r.prepared)})}
  fields(input,['kind','reason']);if(r.kind!=='unavailable' || !['unsupported','source-unavailable','policy','unavailable'].includes(r.reason)) bad()
  return Object.freeze({kind:'unavailable' as const,reason:r.reason as 'unsupported'|'source-unavailable'|'policy'|'unavailable'})
}

const count = (v:unknown): v is number => Number.isSafeInteger(v) && (v as number)>=0
const captures=['uncaptured','captured','unknown']
const issued=['cancelled','stale-source','unsupported','busy','source-unavailable','policy','unavailable']
const refused=['conflict','nonempty','cached-unprepared','wrong-view','incompatible','manifest-invalid','target-policy','invalid-selection','source-unsupported','ambiguous-boundary','no-completed-boundary','straddling-group','unsafe-input-component','invalid-seed','source-changed','legacy-anchor-unsupported','ambiguous','unsupported-history','metadata-limit']
export function readSelectedResultsOutcome(input:unknown, expected:ForkOperationV2): ForkOutcomeV2 {
  const r=fields(input,['version','kind','operation','capture'],['reason','token','sessionId','seedLength','receipt','title'])
  const operation=readSelectedResultsOperation(r.operation)
  if(r.version!==2 || !same(operation,readSelectedResultsOperation(expected)) || !captures.includes(r.capture)) bad()
  const base={version:2 as const,operation,capture:r.capture}
  if(r.kind==='ready' || r.kind==='adopted') {
    fields(input,['version','kind','operation','capture','sessionId','seedLength','receipt'],['title'])
    const receipt=fields(r.receipt,['version','invocation','manifestDigest','seedLength','dependencyClosureDigest','seedDigest','sourceObservation','results'])
    const invocation=readSelectedResultsInvocation(receipt.invocation), source=fields(receipt.sourceObservation,['kind','digest']), results=fields(receipt.results,['version','rows','pages','digest'])
    validateResultsSummary(results)
    if(r.capture!=='captured' || r.sessionId!==operation.invocation.targetSessionId || !count(r.seedLength) || r.seedLength<1 || r.title!==operation.prepared.core.metadata.title || receipt.version!==2 || receipt.seedLength!==r.seedLength || !same(invocation,operation.invocation) || !hash(receipt.manifestDigest) || !hash(receipt.dependencyClosureDigest) || !hash(receipt.seedDigest) || source.kind!=='semantic' || !hash(source.digest) || results.version!==1 || !count(results.rows) || !count(results.pages) || !hash(results.digest)) bad()
    return Object.freeze({...base,kind:r.kind,sessionId:r.sessionId,seedLength:r.seedLength,receipt:Object.freeze({version:2,invocation,manifestDigest:receipt.manifestDigest,seedLength:receipt.seedLength,dependencyClosureDigest:receipt.dependencyClosureDigest,seedDigest:receipt.seedDigest,sourceObservation:Object.freeze({kind:'semantic',digest:source.digest}),results:Object.freeze({version:1,rows:results.rows,pages:results.pages,digest:results.digest})}),...(r.title===undefined?{}:{title:r.title})})
  }
  fields(input,['version','kind','operation','capture','reason'],r.kind==='blocked'?['token']:[])
  if(r.kind==='not-issued' && issued.includes(r.reason) || r.kind==='refused' && refused.includes(r.reason)) return Object.freeze({...base,kind:r.kind,reason:r.reason}) as ForkOutcomeV2
  if(r.kind!=='blocked' || !['unknown','payload-required','dependency-unavailable','source-changed'].includes(r.reason)) bad()
  const t=fields(r.token,['version','invocation','phase'],['manifest','manifestDigest']), invocation=readSelectedResultsInvocation(t.invocation)
  if(t.version!==2 || !same(invocation,operation.invocation)) bad()
  if(t.manifest==='unknown') {fields(r.token,['version','invocation','phase','manifest']);if(t.phase!=='header') bad();return Object.freeze({...base,kind:'blocked',reason:r.reason,token:Object.freeze({version:2,invocation,phase:'header',manifest:'unknown'})}) as ForkOutcomeV2}
  fields(r.token,['version','invocation','phase','manifestDigest']);if(!hash(t.manifestDigest) || !['header','dependencies','seed','completion'].includes(t.phase)) bad()
  return Object.freeze({...base,kind:'blocked',reason:r.reason,token:Object.freeze({version:2,invocation,phase:t.phase,manifestDigest:t.manifestDigest})}) as ForkOutcomeV2
}
export function readSelectedResultsHostError(input:unknown,expected:ForkOperationV2):ForkHostErrorDataV2 {
  const r=fields(input,['version','kind','operation','capture','reason'],['lastOutcome']), operation=readSelectedResultsOperation(r.operation)
  if(r.version!==2 || r.kind!=='session-fork-error' || !same(operation,readSelectedResultsOperation(expected)) || !captures.includes(r.capture) || !['host-unavailable','cleanup-incomplete','internal'].includes(r.reason)) bad()
  const lastOutcome=r.lastOutcome===undefined?undefined:readSelectedResultsOutcome(r.lastOutcome,operation)
  if(lastOutcome?.capture==='captured' && r.capture!=='captured') bad()
  return Object.freeze({version:2,kind:'session-fork-error',operation,capture:r.capture,reason:r.reason,...(lastOutcome===undefined?{}:{lastOutcome})}) as ForkHostErrorDataV2
}
export type CaptureStateV2 = 'uncaptured'|'captured'|'unknown'
export type ResumeTokenV2 = DeepReadonly<{version:2;invocation:BootstrapInvocation;phase:'header';manifest:'unknown'} | {version:2;invocation:BootstrapInvocation;phase:'header'|'dependencies'|'seed'|'completion';manifestDigest:string}>
export type ForkReceiptSummaryV2 = DeepReadonly<{version:2;invocation:BootstrapInvocation;manifestDigest:string;seedLength:number;dependencyClosureDigest:string;seedDigest:string;sourceObservation:{kind:'semantic';digest:string};results:{version:1;rows:number;pages:number;digest:string}}>
export type NotIssuedV2 = 'cancelled'|'stale-source'|'unsupported'|'busy'|'source-unavailable'|'policy'|'unavailable'
export type RefusalV2 = 'conflict'|'nonempty'|'cached-unprepared'|'wrong-view'|'incompatible'|'manifest-invalid'|'target-policy'|'invalid-selection'|'source-unsupported'|'ambiguous-boundary'|'no-completed-boundary'|'straddling-group'|'unsafe-input-component'|'invalid-seed'|'source-changed'|'legacy-anchor-unsupported'|'ambiguous'|'unsupported-history'|'metadata-limit'
export type ForkOutcomeV2 = DeepReadonly<{version:2;kind:'ready'|'adopted';operation:ForkOperationV2;capture:'captured';sessionId:string;seedLength:number;receipt:ForkReceiptSummaryV2;title?:string} | {version:2;kind:'not-issued';operation:ForkOperationV2;capture:CaptureStateV2;reason:NotIssuedV2} | {version:2;kind:'blocked';operation:ForkOperationV2;capture:CaptureStateV2;reason:'unknown'|'payload-required'|'dependency-unavailable'|'source-changed';token:ResumeTokenV2} | {version:2;kind:'refused';operation:ForkOperationV2;capture:CaptureStateV2;reason:RefusalV2}>
export type ForkHostErrorDataV2 = DeepReadonly<{version:2;kind:'session-fork-error';operation:ForkOperationV2;capture:CaptureStateV2;reason:'host-unavailable'|'cleanup-incomplete'|'internal';lastOutcome?:ForkOutcomeV2}>
export type ForkPrepareResultV2 = DeepReadonly<{kind:'prepared';prepared:ForkPreparedV2}|{kind:'unavailable';reason:'unsupported'|'source-unavailable'|'policy'|'unavailable'}>
export type ForkCommandV2 = DeepReadonly<{operation:ForkOperationV2;mode:'begin'|'retry'}>
