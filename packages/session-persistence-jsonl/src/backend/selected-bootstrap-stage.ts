import { basename, dirname, join } from 'node:path'
import { types } from 'node:util'
import { canonicalJsonData, freezeJsonData, isStrictFactData } from '@i-harness/core-session'
import { captureSelectedResultsRoute, parseSelectedResultsReservation, parseSelectedResultsHeaderStage, type SelectedResultsRoute, type SelectedResultsReservationV1, type SelectedResultsHeaderStageV2, type SessionMeta } from '@i-harness/session-persistence'
import { selectedBootstrapPaths } from './selected-results-route-path.ts'
import type { StageLookupIO } from './bootstrap-stage.ts'

export type SelectedStageExpectation = {kind:'route';route:SelectedResultsRoute}|{kind:'header';meta:SessionMeta}
export type SelectedStageLookup = {kind:'absent'}|{kind:'reserved';route:SelectedResultsRoute;reservation:SelectedResultsReservationV1;exactBytes:Uint8Array;promotionBytes?:Uint8Array}|{kind:'full';route:SelectedResultsRoute;stage:SelectedResultsHeaderStageV2;exactBytes:Uint8Array}|{kind:'unavailable'|'conflict';present:boolean}
const same=(a:unknown,b:unknown)=>canonicalJsonData(a)===canonicalJsonData(b)
const headerFields=['formatVersion','sessionId','createdAt','journal','parentSession','seedLength','origin','delegationDepth','subagentProtocolVersion','semanticSeed'] as const
function ownData(input:unknown,key:string,optional=false):any {
 if(!input||typeof input!=='object'||types.isProxy(input))throw TypeError('Expected data object')
 const field=Object.getOwnPropertyDescriptor(input,key)
 if(!field&&optional)return undefined
 if(!field||!('value' in field))throw TypeError('Expected own data field')
 return field.value
}
function captureHeader(input:unknown):Readonly<Partial<SessionMeta>> {
 const fields:Record<string,unknown>={}
 for(const key of headerFields){
  const value=ownData(input,key,true)
  if(value!==undefined){if(!isStrictFactData(value))throw TypeError('Expected header data');fields[key]=value}
 }
 return freezeJsonData(JSON.parse(canonicalJsonData(fields)))
}
function captureMethod<T extends keyof StageLookupIO>(io:StageLookupIO,key:T):StageLookupIO[T] {
 const method=ownData(io,key)
 if(typeof method!=='function'||types.isProxy(method))throw TypeError('Expected IO method')
 return ((...args:unknown[])=>Reflect.apply(method,io,args)) as StageLookupIO[T]
}
function copyBytes(bytes:Uint8Array|undefined,limit:number):Uint8Array|undefined {
 if(bytes===undefined)return undefined
 if(types.isProxy(bytes)||!(bytes instanceof Uint8Array)||bytes.byteLength>limit)throw TypeError('Invalid bounded observation')
 return Buffer.from(bytes)
}
export async function lookupSelectedBootstrapStage(path:string,expectation:SelectedStageExpectation,io:StageLookupIO):Promise<SelectedStageLookup> {
 let present=false
 try {
  // Keep the original owner and receiver; structural copies do not acquire IO authority.
  const assertCurrent=captureMethod(io,'assertCurrent')
  assertCurrent()
  const namespace=captureMethod(io,'namespace'),read=captureMethod(io,'read')
  const kind=ownData(expectation,'kind')
  if(kind!=='route'&&kind!=='header')throw TypeError('Invalid expectation')
  const expected=kind==='route'?captureSelectedResultsRoute(ownData(expectation,'route')):undefined
  const header=kind==='header'?captureHeader(ownData(expectation,'meta')):undefined
  const finish=(value:SelectedStageLookup):SelectedStageLookup=>{assertCurrent();return value}
  assertCurrent()
  const names=Array.from(await namespace());assertCurrent();present=names.length>0
  const prefix=basename(path)+'.bootstrap-'
  if(names.some(n=>!n.startsWith(prefix)||!/^[a-f0-9]{64}\.(stage|promote|publish)$/.test(n.slice(prefix.length)))||new Set(names).size!==names.length)return finish({kind:'unavailable',present})
  let stagePath:string, promotePath:string, publishPath:string
  if(expected){const paths=selectedBootstrapPaths(path,expected);stagePath=paths.stage;promotePath=paths.promote;publishPath=paths.publish}
  else {
   const stages=names.filter(n=>n.endsWith('.stage'))
   if(stages.length!==1)return finish({kind:'unavailable',present})
   stagePath=join(dirname(path),stages[0]!);promotePath=stagePath.slice(0,-6)+'.promote';publishPath=stagePath.slice(0,-6)+'.publish'
  }
  if(names.some(n=>![stagePath,promotePath,publishPath].some(p=>basename(p)===n)))return finish({kind:'conflict',present})
  assertCurrent();const bytes=copyBytes(await read(stagePath,262144),262144);assertCurrent()
  assertCurrent();const promotion=copyBytes(await read(promotePath,262144),262144);assertCurrent()
  assertCurrent();const publish=copyBytes(await read(publishPath,65536),65536);assertCurrent()
  present ||= bytes!==undefined||promotion!==undefined||publish!==undefined
  if(publish!==undefined||names.includes(basename(publishPath)))return finish({kind:'conflict',present:true})
  if(bytes===undefined)return finish(present?{kind:'unavailable',present:true}:{kind:'absent'})
  let reservation:SelectedResultsReservationV1,stage:SelectedResultsHeaderStageV2|undefined
  try{reservation=parseSelectedResultsReservation(bytes)}catch{stage=parseSelectedResultsHeaderStage(bytes);reservation=stage.captureReservation}
  const route=captureSelectedResultsRoute({protocol:'public-results-v1',request:reservation.request})
  if(selectedBootstrapPaths(path,route).stage!==stagePath||expected&&!same(expected,route))return finish({kind:'conflict',present:true})
  if(stage&&promotion!==undefined)return finish({kind:'conflict',present:true})
  if(header){
   if(!stage)return finish({kind:'unavailable',present:true})
   const original=JSON.parse(stage.headerBytes) as SessionMeta
   for(const key of headerFields)if(!same(header[key],original[key]))return finish({kind:'conflict',present:true})
  }
  return finish(stage?{kind:'full',route,stage,exactBytes:bytes}:{kind:'reserved',route,reservation,exactBytes:bytes,...(promotion===undefined?{}:{promotionBytes:promotion})})
 }catch{return {kind:'unavailable',present}}
}
