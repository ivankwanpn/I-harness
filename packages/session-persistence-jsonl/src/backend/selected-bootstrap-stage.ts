import { basename, dirname, join } from 'node:path'
import { canonicalJsonData } from '@i-harness/core-session'
import { captureSelectedResultsRoute, parseSelectedResultsReservation, parseSelectedResultsHeaderStage, type SelectedResultsRoute, type SelectedResultsReservationV1, type SelectedResultsHeaderStageV2, type SessionMeta } from '@i-harness/session-persistence'
import { selectedBootstrapPaths } from './selected-results-route-path.ts'
import type { StageLookupIO } from './bootstrap-stage.ts'

export type SelectedStageExpectation = {kind:'route';route:SelectedResultsRoute}|{kind:'header';meta:SessionMeta}
export type SelectedStageLookup = {kind:'absent'}|{kind:'reserved';route:SelectedResultsRoute;reservation:SelectedResultsReservationV1;exactBytes:Uint8Array;promotionBytes?:Uint8Array}|{kind:'full';route:SelectedResultsRoute;stage:SelectedResultsHeaderStageV2;exactBytes:Uint8Array}|{kind:'unavailable'|'conflict';present:boolean}
const same=(a:unknown,b:unknown)=>canonicalJsonData(a)===canonicalJsonData(b)
export async function lookupSelectedBootstrapStage(path:string,expectation:SelectedStageExpectation,io:StageLookupIO):Promise<SelectedStageLookup> {
 let present=false
 try {
  io.assertCurrent()
  const expected=expectation.kind==='route'?captureSelectedResultsRoute(expectation.route):undefined
  const finish=(value:SelectedStageLookup):SelectedStageLookup=>{io.assertCurrent();return value}
  const names=await io.namespace();io.assertCurrent();present=names.length>0
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
  const bytes=await io.read(stagePath,262144);io.assertCurrent()
  const promotion=await io.read(promotePath,262144);io.assertCurrent()
  const publish=await io.read(publishPath,65536);io.assertCurrent()
  present ||= bytes!==undefined||promotion!==undefined||publish!==undefined
  if(publish!==undefined||names.includes(basename(publishPath)))return finish({kind:'conflict',present:true})
  if(bytes===undefined)return finish(present?{kind:'unavailable',present:true}:{kind:'absent'})
  let reservation:SelectedResultsReservationV1,stage:SelectedResultsHeaderStageV2|undefined
  try{reservation=parseSelectedResultsReservation(bytes)}catch{stage=parseSelectedResultsHeaderStage(bytes);reservation=stage.captureReservation}
  const route=captureSelectedResultsRoute({protocol:'public-results-v1',request:reservation.request})
  if(selectedBootstrapPaths(path,route).stage!==stagePath||expected&&!same(expected,route))return finish({kind:'conflict',present:true})
  if(stage&&promotion!==undefined)return finish({kind:'conflict',present:true})
  if(expectation.kind==='header'){
   if(!stage)return finish({kind:'unavailable',present:true})
   const original=JSON.parse(stage.headerBytes) as SessionMeta,meta=expectation.meta
   for(const key of ['formatVersion','sessionId','createdAt','journal','parentSession','seedLength','origin','delegationDepth','subagentProtocolVersion','semanticSeed'] as const)if(!same(meta[key],original[key]))return finish({kind:'conflict',present:true})
  }
  return finish(stage?{kind:'full',route,stage,exactBytes:bytes}:{kind:'reserved',route,reservation,exactBytes:bytes,...(promotion===undefined?{}:{promotionBytes:promotion})})
 }catch{return {kind:'unavailable',present}}
}

