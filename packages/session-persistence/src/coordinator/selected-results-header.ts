import { canonicalJsonData, freezeJsonData, isStrictFactData, legacyPrefixDigest, validateSubagentHeader, type SeedHeaderV3 } from '@i-harness/core-session'
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
