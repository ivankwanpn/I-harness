import { parseHeader } from '../format.ts'
import { rawHeaderDigest, type BootstrapHeaderOperation } from '@i-harness/session-persistence'
import { createHash } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { open, readdir } from 'node:fs/promises'
import { CURRENT_FORMAT_VERSION, canonicalJsonData, type BootstrapInvocation } from '@i-harness/core-session'
import { captureBootstrapRoute, childBootstrapPathKey, parseBootstrapHeaderStage, parseOwnedCaptureReservation, routeForReservation, routeInvocation, type BootstrapRoute, type BootstrapHeaderStage, type OwnedCaptureReservation, type SessionMeta } from '@i-harness/session-persistence'
export type StagePaths={stage:string;promote:string;publish:string}
export type StageExpectation={kind:'route';route:BootstrapRoute}|{kind:'header';meta:SessionMeta}
export type StageLookupIO={namespace():Promise<readonly string[]>;read(path:string,limit:number):Promise<Uint8Array|undefined>;assertCurrent():void}
export type StageLookup={kind:'absent'}|{kind:'reserved';route:BootstrapRoute;reservation:OwnedCaptureReservation;exactBytes:Uint8Array}|{kind:'full';route:BootstrapRoute;stage:BootstrapHeaderStage;exactBytes:Uint8Array}|{kind:'conflict'|'unavailable';present:boolean}
export function bootstrapPaths(path:string,invocation:BootstrapInvocation):StagePaths {
 const key=createHash('sha256').update(canonicalJsonData(invocation)).digest('hex')
 return {stage:`${path}.bootstrap-${key}.stage`,promote:`${path}.bootstrap-${key}.promote`,publish:`${path}.bootstrap-${key}.publish`}
}
export function bootstrapPathsForRoute(path:string,input:BootstrapRoute):StagePaths {
 const route=captureBootstrapRoute(input),invocation=routeInvocation(route),publicPaths=bootstrapPaths(path,invocation)
 if(route.protocol==='public')return publicPaths
 const key=childBootstrapPathKey(invocation)
 const paths={stage:`${path}.bootstrap-${key}.stage`,promote:`${path}.bootstrap-${key}.promote`,publish:`${path}.bootstrap-${key}.publish`}
 if(paths.stage===publicPaths.stage)throw new TypeError('Bootstrap path collision')
 return paths
}
export async function bootstrapNamespace(path:string):Promise<string[]> {const prefix=basename(path)+'.bootstrap-';return(await readdir(dirname(path))).filter(name=>name.startsWith(prefix))}
export async function boundedBootstrapRead(path:string,limit:number):Promise<Uint8Array|undefined> {
 let h:Awaited<ReturnType<typeof open>>|undefined
 try{h=await open(path,'r');if((await h.stat()).size>limit)throw new TypeError('Bootstrap artifact exceeds limit');const bytes=await h.readFile();if(bytes.length>limit)throw new TypeError('Bootstrap artifact exceeds limit');return bytes}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}finally{await h?.close()}
}
export function ordinaryStageIO(path:string,assertCurrent:()=>void=()=>{}):StageLookupIO {return{namespace:()=>bootstrapNamespace(path),read:boundedBootstrapRead,assertCurrent}}
const same=(a:unknown,b:unknown)=>canonicalJsonData(a)===canonicalJsonData(b)
function matchesHeader(stage:BootstrapHeaderStage,meta:SessionMeta) {
 const original=JSON.parse(stage.headerBytes) as SessionMeta
 if(meta.formatVersion!==original.formatVersion&&!([11,12].includes(original.formatVersion)&&meta.formatVersion>original.formatVersion&&meta.formatVersion<=CURRENT_FORMAT_VERSION)&&!(original.formatVersion===13&&meta.formatVersion===14))throw TypeError('Bootstrap format mismatch')
 for(const key of ['sessionId','createdAt','journal','parentSession','seedLength','origin','delegationDepth','subagentProtocolVersion','subagentTaskId','subagentAgentPath','semanticSeed'] as const)if(!same(meta[key],original[key]))throw TypeError('Bootstrap header mismatch')
}
export async function lookupBootstrapStage(path:string,expectation:StageExpectation,io:StageLookupIO):Promise<StageLookup> {
 let present=false
 try {
  io.assertCurrent();const names=await io.namespace();io.assertCurrent();present=names.length>0
  const prefix=basename(path)+'.bootstrap-'
  if(names.some(n=>!n.startsWith(prefix)||!/^[a-f0-9]{64}\.(stage|promote|publish)$/.test(n.slice(prefix.length))))return{kind:'unavailable',present}
  const invocation=expectation.kind==='route'?routeInvocation(expectation.route):expectation.meta.semanticSeed?{version:1 as const,operationId:expectation.meta.semanticSeed.operationId,targetSessionId:expectation.meta.sessionId,createdAt:expectation.meta.createdAt,requestDigest:expectation.meta.semanticSeed.requestDigest}:undefined
  if(!invocation)return names.length?{kind:'conflict',present}: {kind:'absent'}
  const pub=bootstrapPaths(path,invocation),childKey=childBootstrapPathKey(invocation),child={stage:`${path}.bootstrap-${childKey}.stage`,promote:`${path}.bootstrap-${childKey}.promote`,publish:`${path}.bootstrap-${childKey}.publish`}
  const candidates=expectation.kind==='route'?[bootstrapPathsForRoute(path,expectation.route)]:[pub,child]
  const owned=candidates.filter(p=>names.includes(basename(p.stage)))
  if(owned.length>1)return{kind:'conflict',present:true}
  const selected=owned[0]??candidates[0]!
  if(names.some(n=>![selected.stage,selected.promote,selected.publish].some(p=>basename(p)===n)))return{kind:'conflict',present}
  const bytes=await io.read(selected.stage,262144);io.assertCurrent()
  const promote=await io.read(selected.promote,262144);io.assertCurrent()
  const publish=await io.read(selected.publish,65536);io.assertCurrent()
  present ||= bytes!==undefined||promote!==undefined||publish!==undefined
  if(bytes===undefined)return present?{kind:'unavailable',present}: {kind:'absent'}
  let reservation:OwnedCaptureReservation|undefined,stage:BootstrapHeaderStage|undefined
  try{reservation=parseOwnedCaptureReservation(bytes)}catch{stage=parseBootstrapHeaderStage(bytes);reservation=stage.captureReservation}
  const route:BootstrapRoute=reservation?routeForReservation(reservation):{protocol:'public',invocation:stage!.invocation}
  if(bootstrapPathsForRoute(path,route).stage!==selected.stage||!same(routeInvocation(route),invocation))return{kind:'conflict',present:true}
  if(expectation.kind==='route'&&!same(route,expectation.route))return{kind:'conflict',present:true}
  if(stage&&reservation&&!same(reservation.request.invocation,stage.invocation))return{kind:'conflict',present:true}
  if(promote!==undefined){const full=parseBootstrapHeaderStage(promote);if(stage||!reservation||!same(full.captureReservation,reservation)||!same(full.invocation,invocation))return{kind:'conflict',present:true}}
  if(publish!==undefined){if(!stage||stage.originalTarget.kind==='new')return{kind:'conflict',present:true};const expected=Buffer.from(stage.headerBytes);if(publish.length>expected.length||!Buffer.from(publish).equals(expected.subarray(0,publish.length)))return{kind:'conflict',present:true}}
  if(expectation.kind==='header'){if(!stage)return{kind:'unavailable',present:true};matchesHeader(stage,expectation.meta)}
  io.assertCurrent()
  return stage?{kind:'full',route,stage,exactBytes:bytes}:{kind:'reserved',route,reservation:reservation!,exactBytes:bytes}
 }catch{return{kind:'unavailable',present}}
}

const MUTABLE_BOOTSTRAP_HEADER_FIELDS = new Set(['title', 'workspaceId', 'archived', 'modelSelection'])
/** Compare a live storage header with its immutable original birth. */
export function sameImmutableBootstrapHeader(live: Record<string, unknown>, staged: Record<string, unknown>): boolean {
  const oldVersion = staged.formatVersion, liveVersion = live.formatVersion
  const supportedUpgrade = typeof oldVersion === 'number' && typeof liveVersion === 'number'
    && Number.isSafeInteger(oldVersion) && Number.isSafeInteger(liveVersion)
    && [11, 12, 13].includes(oldVersion) && liveVersion > oldVersion && liveVersion <= CURRENT_FORMAT_VERSION
  for (const key of new Set([...Object.keys(live), ...Object.keys(staged)])) {
    if (MUTABLE_BOOTSTRAP_HEADER_FIELDS.has(key) || key === 'formatVersion' && supportedUpgrade) continue
    if (live[key] === staged[key]) continue
    try { if (canonicalJsonData(live[key]) === canonicalJsonData(staged[key])) continue } catch { return false }
    return false
  }
  return true
}

export function originalEmptyTarget(actual:Buffer,id:string,operation:BootstrapHeaderOperation):boolean {
  if(operation.target.kind!=='existing-empty')return false
  try {
    const end=actual.indexOf(10),meta=end>=0?parseHeader(actual.subarray(0,end).toString('utf8')):undefined
    return end===actual.length-1&&!!meta&&!meta.semanticSeed&&[11,12,13,14].includes(meta.formatVersion)&&meta.sessionId===id&&meta.createdAt===operation.invocation.createdAt
      &&rawHeaderDigest(actual)===operation.target.expectedHeaderDigest&&meta.journal?.legacyEventCount===0&&meta.journal?.legacyBodyBytes===0
      &&meta.journal?.separatorBytes===0&&meta.journal?.legacyPrefixDigest===operation.target.expectedPrefix.prefixDigest
  }catch{return false}
}
