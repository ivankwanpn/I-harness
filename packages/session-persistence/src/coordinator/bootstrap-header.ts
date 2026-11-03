import { createHash } from 'node:crypto'
import { CURRENT_FORMAT_VERSION, canonicalJsonData, isStrictFactData, freezeJsonData, legacyPrefixDigest, validateSubagentHeader, validateConversationEventShape, validateSemanticSeed, type BootstrapInvocation, type SessionEvent, type SeedHeader } from '@i-harness/core-session'
import { bootstrapInitialInputDigest, semanticSeedBodyFromRecords } from '@i-harness/core-session/internal/bootstrap'
import { PROVIDER_PROTOCOLS } from '@i-harness/settings'
import { bootstrapHash, compileSemanticSeed } from '../semantic-seed.ts'
import type { BootstrapHeaderOperation, BootstrapHeaderStage, BootstrapRequest } from './bootstrap-types.ts'
import type { SessionMeta } from './types.ts'
import type { OwnedCaptureReservation } from './child-bootstrap-intent.ts'
import { encodeOwnedCaptureReservation, parseOwnedCaptureReservation, validateOwnedCaptureStage } from './bootstrap-route.ts'

const bad = (): never => { throw new TypeError('Invalid bootstrap materialization') }
const digest = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
export const sameBootstrapData = (a: unknown, b: unknown): boolean => canonicalJsonData(a) === canonicalJsonData(b)
export function bootstrapFields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isStrictFactData(value)
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !field.enumerable)
    || required.some(key => !Object.hasOwn(value, key)) || Object.getOwnPropertyNames(value).some(key => !required.includes(key) && !optional.includes(key))
    || Object.values(value).some(x => x === undefined)) bad()
}
const fields: typeof bootstrapFields = bootstrapFields
export function captureBootstrapInvocation(value: BootstrapInvocation): BootstrapInvocation {
  fields(value, ['version','operationId','targetSessionId','createdAt','requestDigest'])
  if (value.version !== 1 || typeof value.operationId !== 'string' || !/^[\x21-\x7e]{1,237}$/.test(value.operationId) || !id(value.targetSessionId)
    || !digest(value.requestDigest) || typeof value.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString()!==value.createdAt) bad()
  return freezeJsonData(JSON.parse(canonicalJsonData(value))) as BootstrapInvocation
}
function validateTarget(value: BootstrapRequest['target']) {
  if (value.kind === 'new') fields(value, ['kind'])
  else if (value.kind === 'resume') { fields(value,['kind','manifestDigest']); if (!digest(value.manifestDigest)) bad() }
  else if (value.kind === 'existing-empty') {
    fields(value,['kind','expectedHeaderDigest','expectedPrefix']); fields(value.expectedPrefix,['eventCount','bodyBytes','prefixDigest'])
    if (!digest(value.expectedHeaderDigest) || value.expectedPrefix.eventCount !== 0 || value.expectedPrefix.bodyBytes !== 0 || value.expectedPrefix.prefixDigest !== legacyPrefixDigest(0,new Uint8Array())) bad()
  } else bad()
}
export function validateCreation(metadata: BootstrapRequest['metadata'], lineage: BootstrapRequest['lineage']) {
  fields(metadata,[],['title','workspaceId','modelSelection']); fields(lineage,['origin'],['parentSession','delegationDepth','subagentProtocolVersion'])
  if (metadata.title !== undefined && (typeof metadata.title !== 'string' || Buffer.byteLength(metadata.title) > 32768) || metadata.workspaceId !== undefined && !id(metadata.workspaceId)) bad()
  if (metadata.modelSelection !== undefined) {
    const m=metadata.modelSelection; fields(m,['provider','model'],['protocol','reasoningEffort'])
    if (!id(m.provider) || !id(m.model) || m.reasoningEffort !== undefined && !id(m.reasoningEffort) || m.protocol !== undefined && !(PROVIDER_PROTOCOLS as readonly string[]).includes(m.protocol)) bad()
  }
  if (!['subagent','approval-review','team','fork','import'].includes(lineage.origin) || lineage.parentSession !== undefined && !id(lineage.parentSession)
    || lineage.delegationDepth !== undefined && !count(lineage.delegationDepth) || (lineage.origin === 'subagent') !== (lineage.subagentProtocolVersion === 1)
    || lineage.origin === 'import' && lineage.parentSession !== undefined) bad()
}
export function captureBootstrapRequest(value: BootstrapRequest): BootstrapRequest {
  fields(value,['invocation','target','metadata','lineage','seed'],['initial'])
  captureBootstrapInvocation(value.invocation); validateTarget(value.target); validateCreation(value.metadata,value.lineage)
  const seed=value.seed; fields(seed,['digest','dependencyDigest','sourceObservation','records'])
  if (!Array.isArray(seed.records)) bad()
  let compiled
  if (!seed.records.length) compiled=compileSemanticSeed({kind:'none'})
  else {
    const [m,...groups]=seed.records
    if (m?.type !== 'conversation/seed-manifest' || !(m.version === 1 && m.codec === 'semantic-seed-v1' || m.version === 2 && m.codec === 'semantic-seed-v2') || groups.some((g,i) => g.type !== 'conversation/seed-group' || g.seq !== i+1 || g.ordinal !== i || g.manifestSeq !== 0)) bad()
    const semantic=validateSemanticSeed(semanticSeedBodyFromRecords(seed.records))
    if (semantic.version !== 1 && semantic.version !== 2) throw new TypeError('Legacy bootstrap request required')
    if (seed.sourceObservation.kind !== 'semantic') bad()
    compiled=compileSemanticSeed({kind:'seed',seed:semantic,digest:seed.digest,sourceObservationDigest:(seed.sourceObservation as {kind:"semantic";digest:string}).digest})
  }
  if (!sameBootstrapData(seed,compiled)) bad()
  const first=seed.records[0]
  if(first?.type==='conversation/seed-manifest') {
    const source=first.origins[0]
    if(value.lineage.parentSession!==undefined&&(source?.kind!=='session'||source.sessionId!==value.lineage.parentSession))bad()
  }
  if (value.initial) {
    fields(value.initial,['inputId','text','startedAt','expiresAt'],['parentSessionId'])
    if (!id(value.initial.inputId) || typeof value.initial.text !== 'string' || !value.initial.text || !count(value.initial.startedAt) || !count(value.initial.expiresAt) || value.initial.expiresAt <= value.initial.startedAt
      || value.initial.parentSessionId !== value.lineage.parentSession) bad()
  }
  return freezeJsonData(JSON.parse(canonicalJsonData(value))) as BootstrapRequest
}
export function initialAdmission(request: Pick<BootstrapRequest,'initial'>): SessionEvent | undefined {
  const initial=request.initial
  if (!initial) return
  const event: SessionEvent={type:'agent/input/admitted',version:1,inputId:initial.inputId,text:initial.text,delivery:'queue',intent:'user',provenance:{kind:'inherited',authority:'observation',scope:'turn',producer:'subagent.initial',...(initial.parentSessionId ? {originSessionId:initial.parentSessionId}: {})}}
  validateConversationEventShape(event,11)
  return event
}
export function bootstrapManifest(stage: Omit<BootstrapHeaderStage,'headerBytes'>, records: BootstrapRequest['seed']['records']): string {
  return bootstrapHash('ih.bootstrap.manifest.v1',{version:1,invocation:stage.invocation,target:stage.originalTarget,metadata:stage.metadata,lineage:stage.lineage,headerBase:stage.headerBase,
    seed:{digest:stage.seed.digest,dependencyDigest:stage.seed.dependencyDigest,sourceObservation:stage.seed.sourceObservation,records},...(stage.initial ? {initial:stage.initial}: {})})
}
export function buildBootstrapHeader(request: BootstrapRequest, original?: BootstrapHeaderStage, existing?: Record<string,unknown>, captureReservation?: OwnedCaptureReservation): {stage:BootstrapHeaderStage;operation:BootstrapHeaderOperation;initial?:SessionEvent} {
  if(original)fields(original,['version','kind','invocation','originalTarget','metadata','lineage','headerBase','seed','headerBytes'],['initial','captureReservation'])
  const r=captureBootstrapRequest(request), initial=initialAdmission(r)
  if (original && arguments.length >= 4 && !sameBootstrapData(captureReservation, original.captureReservation)) bad()
  const reservation = original ? original.captureReservation : captureReservation
  const capturedReservation = reservation === undefined ? undefined : parseOwnedCaptureReservation(encodeOwnedCaptureReservation(reservation))
  if (r.target.kind === 'resume' && !original) bad()
  const headerBase:SessionMeta=original?.headerBase ?? { ...existing, formatVersion:CURRENT_FORMAT_VERSION, sessionId:r.invocation.targetSessionId,createdAt:r.invocation.createdAt,
    journal:{version:1,legacyBodyBytes:0,legacyEventCount:0,legacyPrefixDigest:legacyPrefixDigest(0,new Uint8Array()),separatorBytes:0},...r.metadata,...r.lineage,seedLength:r.seed.records.length }
  if(!original)for(const key of ['parentSession','delegationDepth','subagentProtocolVersion'] as const)if(r.lineage[key]===undefined)delete headerBase[key]
  const core:Omit<BootstrapHeaderStage,'headerBytes'>={version:1,kind:'semantic-bootstrap-header',invocation:r.invocation,originalTarget:original?.originalTarget ?? r.target as BootstrapHeaderStage['originalTarget'],metadata:r.metadata,lineage:r.lineage,headerBase,
    seed:{digest:r.seed.digest,dependencyDigest:r.seed.dependencyDigest,sourceObservation:r.seed.sourceObservation,seedLength:r.seed.records.length,groupCount:Math.max(0,r.seed.records.length-1)},
    ...(initial ? {initial:{inputId:r.initial!.inputId,digest:bootstrapInitialInputDigest(initial,r.initial!.startedAt,r.initial!.expiresAt),startedAt:r.initial!.startedAt,expiresAt:r.initial!.expiresAt}}: {})}
  if (capturedReservation) { core.captureReservation = capturedReservation; validateOwnedCaptureStage(capturedReservation, core as BootstrapHeaderStage, r.seed.records) }
  const manifestDigest=bootstrapManifest(core,r.seed.records)
  if(r.target.kind==='resume'&&r.target.manifestDigest!==manifestDigest)bad()
  const discriminator = r.seed.records[0]?.version === 2 ? {version:2 as const,codec:'semantic-seed-v2' as const} : {version:1 as const,codec:'semantic-seed-v1' as const}
  const semanticSeed:SeedHeader={...discriminator,operationId:r.invocation.operationId,requestDigest:r.invocation.requestDigest,manifestDigest,seedDigest:r.seed.digest,dependencyDigest:r.seed.dependencyDigest,seedLength:core.seed.seedLength,groupCount:core.seed.groupCount,
    ...(core.initial ? {initialInputId:core.initial.inputId,initialInputDigest:core.initial.digest,initialStartedAt:core.initial.startedAt,initialExpiresAt:core.initial.expiresAt}: {})}
  validateSubagentHeader({semanticSeed,...r.lineage})
  const headerBytes=canonicalJsonData({...headerBase,semanticSeed})+'\n'
  const stage:BootstrapHeaderStage={...core,headerBytes}, stageBytes=Buffer.from(canonicalJsonData(stage)+'\n')
  if (Buffer.byteLength(headerBytes)>65536 || stageBytes.length>262144) bad()
  if (original && !sameBootstrapData(stage,original)) bad()
  return {stage,operation:{invocation:r.invocation,target:core.originalTarget,stageBytes,headerBytes:Buffer.from(headerBytes)},...(initial ? {initial}: {})}
}
export function parseBootstrapHeaderStage(bytes: Uint8Array): BootstrapHeaderStage {
  if (bytes.length>262144) bad()
  const value=JSON.parse(Buffer.from(bytes).toString('utf8')) as BootstrapHeaderStage
  fields(value,['version','kind','invocation','originalTarget','metadata','lineage','headerBase','seed','headerBytes'],['initial','captureReservation'])
  if (value.version!==1 || value.kind!=='semantic-bootstrap-header' || typeof value.headerBytes!=='string' || Buffer.byteLength(value.headerBytes)>65536 || !value.headerBytes.endsWith('\n')) bad()
  captureBootstrapInvocation(value.invocation); validateTarget(value.originalTarget); if ((value.originalTarget as BootstrapRequest['target']).kind==='resume') bad()
  validateCreation(value.metadata,value.lineage)
  fields(value.seed,['digest','dependencyDigest','sourceObservation','seedLength','groupCount'])
  if (![value.seed.digest,value.seed.dependencyDigest].every(digest) || !count(value.seed.seedLength) || !count(value.seed.groupCount)) bad()
  fields(value.seed.sourceObservation,value.seed.sourceObservation.kind==='none' ? ['kind']:['kind','digest'])
  if (!['none','semantic'].includes(value.seed.sourceObservation.kind) || value.seed.sourceObservation.kind==='semantic' && !digest(value.seed.sourceObservation.digest)) bad()
  if (value.initial) { fields(value.initial,['inputId','digest','startedAt','expiresAt']); if (!id(value.initial.inputId)||!digest(value.initial.digest)||!count(value.initial.startedAt)||!count(value.initial.expiresAt)||value.initial.expiresAt<=value.initial.startedAt) bad() }
  const header=JSON.parse(value.headerBytes) as SessionMeta, s=header.semanticSeed
  if (!s || !(s.version === 1 && s.codec === 'semantic-seed-v1' || s.version === 2 && s.codec === 'semantic-seed-v2')) bad()
  validateSubagentHeader(header)
  if (!s || ![11,12,13,14].includes(header.formatVersion) || header.journal?.version!==1 || header.journal.legacyBodyBytes!==0 || header.journal.legacyEventCount!==0 || header.journal.separatorBytes!==0 || header.journal.legacyPrefixDigest!==legacyPrefixDigest(0,new Uint8Array())
    || header.sessionId!==value.invocation.targetSessionId || header.createdAt!==value.invocation.createdAt || s.operationId!==value.invocation.operationId || s.requestDigest!==value.invocation.requestDigest
    || s.seedDigest!==value.seed.digest || s.dependencyDigest!==value.seed.dependencyDigest || s.seedLength!==value.seed.seedLength || s.groupCount!==value.seed.groupCount || header.seedLength!==s.seedLength
    || s.initialInputId!==value.initial?.inputId || s.initialInputDigest!==value.initial?.digest || s.initialStartedAt!==value.initial?.startedAt || s.initialExpiresAt!==value.initial?.expiresAt) bad()
  const {semanticSeed:_,...base}=header
  if (!sameBootstrapData(base,value.headerBase) || !sameBootstrapData({...base,...value.metadata,...value.lineage},base)) bad()
  if (Object.hasOwn(value,'captureReservation')) validateOwnedCaptureStage(value.captureReservation!, value)
  if (!Buffer.from(canonicalJsonData(value)+'\n').equals(Buffer.from(bytes))) bad()
  return value
}
export const rawHeaderDigest=(bytes:Uint8Array):string=>createHash('sha256').update(bytes).digest('hex')
