import { canonicalJsonData, freezeJsonData, isStrictFactData, legacyPrefixDigest, validateSubagentHeader, validateResultsSummary, type SeedHeaderV3 } from '@i-harness/core-session'
import { types } from 'node:util'
import { semanticSeedBodyFromRecords, seedLayout } from '@i-harness/core-session/internal/bootstrap'
import { bootstrapHash, compileSelectedResultsSemanticSeed } from '../semantic-seed.ts'
import { bootstrapFields } from './bootstrap-header.ts'
import { encodeSelectedResultsReservation, parseSelectedResultsReservation } from './selected-results-intent.ts'

const invalid = (): never => { throw new TypeError('Invalid selected results materialization') }
const same = (a: unknown, b: unknown): boolean => canonicalJsonData(a) === canonicalJsonData(b)
/** Check all descriptors before copying, including arrays and fields JSON would discard. */
function captureData(input: unknown): any {
  if (!isStrictFactData(input)) invalid()
  const stack = [input]
  while (stack.length) {
    const value = stack.pop()
    if (value === undefined) invalid()
    if (!value || typeof value !== 'object') continue
    const descriptors = Object.getOwnPropertyDescriptors(value), array = Array.isArray(value)
    if (array && Reflect.ownKeys(value).length !== value.length + 1) invalid()
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue
      if (!descriptor.enumerable || array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) invalid()
      stack.push(descriptor.value)
    }
  }
  return JSON.parse(canonicalJsonData(input))
}
/** Pure construction only; validates commitments but does not grant capture or publication authority. */
export function buildSelectedResultsHeader(input: unknown, reservationInput: unknown) {
  const request = captureData(input)
  bootstrapFields(request,['invocation','target','metadata','lineage','seed'])
  bootstrapFields(request.target,['kind']); if (request.target.kind !== 'new') invalid()
  bootstrapFields(request.lineage,['origin','parentSession'])
  bootstrapFields(request.seed,['digest','dependencyDigest','sourceObservation','records'])
  const reservation = parseSelectedResultsReservation(encodeSelectedResultsReservation(reservationInput))
  const captured = reservation.request
  if (!same(request.invocation,captured.invocation) || !same(request.metadata,captured.core.metadata)
    || request.lineage.origin !== 'fork' || request.lineage.parentSession !== captured.core.sourceSessionId) invalid()
  const records = request.seed.records
  if (!Array.isArray(records) || !records.length) invalid()
  const first = records[0], seed = semanticSeedBodyFromRecords(records)
  if (seed.version !== 3 || seed.profile !== 'public-completed') throw new TypeError('Public selected seed required')
  if (first.version !== 3 || first.codec !== 'semantic-seed-v3'
    || !same(seed.selection,captured.core.selection) || seed.origins[0]?.kind !== 'session' || seed.origins[0].sessionId !== captured.core.sourceSessionId
    || request.seed.sourceObservation?.kind !== 'semantic' || seed.origins[0].revision !== request.seed.sourceObservation.digest) invalid()
  const compiled = compileSelectedResultsSemanticSeed({kind:'seed',seed,digest:request.seed.digest,sourceObservationDigest:request.seed.sourceObservation.digest})
  if (!same(compiled,request.seed)) invalid()
  const layout = seedLayout(first)
  const invocation = captured.invocation, metadata = captured.core.metadata
  const lineage = {origin:'fork' as const,parentSession:captured.core.sourceSessionId}
  const headerBase = {formatVersion:13 as const,sessionId:invocation.targetSessionId,createdAt:invocation.createdAt,
    journal:{version:1 as const,legacyBodyBytes:0 as const,legacyEventCount:0 as const,legacyPrefixDigest:legacyPrefixDigest(0,new Uint8Array()),separatorBytes:0 as const},
    seedLength:layout.seedLength,origin:lineage.origin,parentSession:lineage.parentSession,
    ...(metadata.title === undefined ? {} : {title:metadata.title}),...(metadata.workspaceId === undefined ? {} : {workspaceId:metadata.workspaceId}),
    ...(metadata.modelSelection === undefined ? {} : {modelSelection:metadata.modelSelection})}
  const stageSeed = {digest:compiled.digest,dependencyDigest:compiled.dependencyDigest,sourceObservation:compiled.sourceObservation,
    seedLength:layout.seedLength,groupCount:layout.groupCount,resultPageCount:layout.resultPageCount,profile:'public-completed' as const,results:seed.results.summary}
  const originalTarget = {kind:'new' as const}
  const manifestDigest = bootstrapHash('ih.bootstrap.selected-results.manifest.v1',{version:2,route:{protocol:'public-results-v1',request:captured},
    captureReservation:reservation,invocation,target:originalTarget,metadata,lineage,headerBase,seed:{...stageSeed,records}})
  const semanticSeed: SeedHeaderV3 = {version:3,codec:'semantic-seed-v3',profile:'public-completed',results:stageSeed.results,resultPageCount:layout.resultPageCount,
    operationId:invocation.operationId,requestDigest:invocation.requestDigest,manifestDigest,seedDigest:compiled.digest,dependencyDigest:compiled.dependencyDigest,
    seedLength:layout.seedLength,groupCount:layout.groupCount}
  seedLayout(semanticSeed)
  const header = {...headerBase,semanticSeed}
  validateSubagentHeader(header)
  const headerBytes = canonicalJsonData(header)+'\n'
  const stage = freezeJsonData({version:2 as const,kind:'semantic-bootstrap-selected-results-header' as const,captureReservation:reservation,
    invocation,originalTarget,metadata,lineage,headerBase,seed:stageSeed,headerBytes})
  const stageBytes = canonicalJsonData(stage)+'\n'
  if (Buffer.byteLength(headerBytes)>65536 || Buffer.byteLength(stageBytes)>262144) invalid()
  return Object.freeze({stage,stageBytes,headerBytes})
}
export type SelectedResultsHeaderStageV2 = ReturnType<typeof buildSelectedResultsHeader>['stage']
/** Structural admission only. This cannot verify the outer manifest without the records. */
export function parseSelectedResultsHeaderStage(bytes: Uint8Array): SelectedResultsHeaderStageV2 {
  if (types.isProxy(bytes) || !(bytes instanceof Uint8Array) || bytes.length > 262144) invalid()
  const stage = captureData(JSON.parse(Buffer.from(bytes).toString('utf8')))
  bootstrapFields(stage,['version','kind','captureReservation','invocation','originalTarget','metadata','lineage','headerBase','seed','headerBytes'])
  if (stage.version !== 2 || stage.kind !== 'semantic-bootstrap-selected-results-header' || typeof stage.headerBytes !== 'string' || Buffer.byteLength(stage.headerBytes)>65536) invalid()
  const reservation = parseSelectedResultsReservation(encodeSelectedResultsReservation(stage.captureReservation)), request=reservation.request
  bootstrapFields(stage.originalTarget,['kind']); bootstrapFields(stage.lineage,['origin','parentSession'])
  if (stage.originalTarget.kind !== 'new' || !same(stage.invocation,request.invocation) || !same(stage.metadata,request.core.metadata)
    || stage.lineage.origin !== 'fork' || stage.lineage.parentSession !== request.core.sourceSessionId) invalid()
  const seed=stage.seed
  bootstrapFields(seed,['digest','dependencyDigest','sourceObservation','seedLength','groupCount','resultPageCount','profile','results'])
  bootstrapFields(seed.sourceObservation,['kind','digest'])
  const digest=(x:unknown)=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x)
  if (!digest(seed.digest) || !digest(seed.dependencyDigest) || seed.sourceObservation.kind !== 'semantic' || !digest(seed.sourceObservation.digest) || seed.profile !== 'public-completed') invalid()
  validateResultsSummary(seed.results)
  const header = captureData(JSON.parse(stage.headerBytes))
  bootstrapFields(header,['formatVersion','sessionId','createdAt','journal','seedLength','origin','parentSession','semanticSeed'],['title','workspaceId','modelSelection'])
  const semantic = header.semanticSeed
  validateSubagentHeader(header)
  if (semantic.version !== 3 || semantic.codec !== 'semantic-seed-v3' || semantic.profile !== 'public-completed') invalid()
  seedLayout(semantic)
  const invocation=request.invocation, metadata=request.core.metadata
  const expectedBase={formatVersion:13,sessionId:invocation.targetSessionId,createdAt:invocation.createdAt,
    journal:{version:1,legacyBodyBytes:0,legacyEventCount:0,legacyPrefixDigest:legacyPrefixDigest(0,new Uint8Array()),separatorBytes:0},
    seedLength:seed.seedLength,origin:'fork',parentSession:request.core.sourceSessionId,
    ...(metadata.title === undefined ? {} : {title:metadata.title}),...(metadata.workspaceId === undefined ? {} : {workspaceId:metadata.workspaceId}),
    ...(metadata.modelSelection === undefined ? {} : {modelSelection:metadata.modelSelection})}
  const {semanticSeed:_,...base}=header
  if (!same(base,expectedBase) || !same(stage.headerBase,expectedBase)
    || semantic.operationId !== invocation.operationId || semantic.requestDigest !== invocation.requestDigest
    || semantic.seedDigest !== seed.digest || semantic.dependencyDigest !== seed.dependencyDigest
    || semantic.seedLength !== seed.seedLength || semantic.groupCount !== seed.groupCount || semantic.resultPageCount !== seed.resultPageCount
    || !same(semantic.results,seed.results) || stage.headerBytes !== canonicalJsonData(header)+'\n'
    || !Buffer.from(canonicalJsonData(stage)+'\n').equals(Buffer.from(bytes))) invalid()
  return freezeJsonData(stage) as SelectedResultsHeaderStageV2
}
/** Verifies complete records against every stage, source and manifest commitment; no source callback is used. */
export function reconstituteSelectedResultsStage(input: unknown, recordInput: unknown) {
  const stageData=captureData(input)
  const stage=parseSelectedResultsHeaderStage(Buffer.from(canonicalJsonData(stageData)+'\n'))
  const records=captureData(recordInput)
  if (!Array.isArray(records)) invalid()
  const seed=semanticSeedBodyFromRecords(records)
  if (seed.version !== 3 || seed.profile !== 'public-completed') throw new TypeError('Public selected seed required')
  const compiled=compileSelectedResultsSemanticSeed({kind:'seed',seed,digest:stage.seed.digest,sourceObservationDigest:stage.seed.sourceObservation.digest})
  const rebuilt=buildSelectedResultsHeader({invocation:stage.invocation,target:stage.originalTarget,metadata:stage.metadata,lineage:stage.lineage,seed:compiled},stage.captureReservation)
  if (!same(compiled.records,records) || !same(rebuilt.stage,stage)) invalid()
  return Object.freeze({stage,seed:freezeJsonData(compiled)})
}
