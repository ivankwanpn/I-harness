import { expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { codecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { buildSelectedResultsHeader } from '../../session-persistence/src/coordinator/selected-results-header.ts'
import { encodeSelectedResultsReservation } from '../../session-persistence/src/coordinator/selected-results-intent.ts'
import { lookupBootstrapStage, ordinaryStageIO } from '../src/backend/bootstrap-stage.ts'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
import { lookupSelectedBootstrapStage } from '../src/backend/selected-bootstrap-stage.ts'
function fixture(){
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{title:'test'},results:'selected-results-v1'})
 const {intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}
 const request={invocation,core,requestIntent:intent},route={protocol:'public-results-v1' as const,request},reservation={version:1,kind:'semantic-bootstrap-selected-results-capture',request}
 const built=buildSelectedResultsHeader({invocation,target:{kind:'new'},metadata:core.metadata,lineage:{origin:'fork',parentSession:'source'},seed:compileSelectedResultsSemanticSeed(codecSeed('public-completed'))},reservation)
 return {route,reservation,built}
}
it('reads absent, reservation, full and promotion observations without changing bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ih-sel-'));try{
 const path=join(root,'target.jsonl'),{route,reservation,built}=fixture(),paths=selectedBootstrapPaths(path,route),io=ordinaryStageIO(path),expected={kind:'route' as const,route}
 expect((await lookupSelectedBootstrapStage(path,expected,io)).kind).toBe('absent')
 await writeFile(paths.stage,encodeSelectedResultsReservation(reservation));expect((await lookupSelectedBootstrapStage(path,expected,io)).kind).toBe('reserved')
 await writeFile(paths.promote,Buffer.from('{'));const observed=await lookupSelectedBootstrapStage(path,expected,io);expect(observed).toMatchObject({kind:'reserved',promotionBytes:Buffer.from('{')})
 await rm(paths.promote);await writeFile(paths.stage,built.stageBytes);const before=await readFile(paths.stage)
 expect((await lookupSelectedBootstrapStage(path,expected,io)).kind).toBe('full')
 expect((await lookupSelectedBootstrapStage(path,{kind:'header',meta:JSON.parse(built.headerBytes)},io)).kind).toBe('full')
 expect((await lookupBootstrapStage(path,{kind:'route',route:{protocol:'public',invocation:route.request.invocation}},io)).kind).toBe('conflict')
 expect(await readFile(paths.stage)).toEqual(before);expect(await readdir(root)).toHaveLength(1)
 }finally{await rm(root,{recursive:true,force:true})}
})
it.each(['empty','torn','oversize','publish','foreign','mixed'] as const)('refuses %s without changing files',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'ih-sel-'));try{
 const path=join(root,'target.jsonl'),{route,reservation}=fixture(),paths=selectedBootstrapPaths(path,route)
 const stage=mode==='empty'?Buffer.alloc(0):mode==='torn'?Buffer.from('{'):mode==='oversize'?Buffer.alloc(262145):encodeSelectedResultsReservation(reservation)
 await writeFile(paths.stage,stage)
 if(mode==='publish')await writeFile(paths.publish,'x')
 if(mode==='foreign'||mode==='mixed')await writeFile(path+'.bootstrap-'+ 'a'.repeat(64)+(mode==='foreign'?'.unknown':'.stage'),'x')
 const names=await readdir(root),before=await Promise.all(names.map(n=>readFile(join(root,n))))
 expect(['unavailable','conflict']).toContain((await lookupSelectedBootstrapStage(path,{kind:'route',route},ordinaryStageIO(path))).kind)
 expect(await Promise.all(names.map(n=>readFile(join(root,n))))).toEqual(before)
 }finally{await rm(root,{recursive:true,force:true})}
})
it('returns no value after currentness loss at any asynchronous boundary',async()=>{
 const {route}=fixture()
 for(let fail=1;fail<=5;fail++){let calls=0;const io={assertCurrent(){if(++calls===fail)throw Error('lost')},async namespace(){return []},async read(){return undefined}}
 expect((await lookupSelectedBootstrapStage('target.jsonl',{kind:'route',route},io)).kind).toBe('unavailable')}
})
it('binds full request and immutable header while accepting mutable metadata',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ih-sel-'));try{
 const path=join(root,'target.jsonl'),{route,built}=fixture(),paths=selectedBootstrapPaths(path,route),io=ordinaryStageIO(path)
 expect((await lookupSelectedBootstrapStage(path,{kind:'header',meta:JSON.parse(built.headerBytes)},io)).kind).toBe('unavailable')
 await writeFile(paths.stage,built.stageBytes)
 const meta=JSON.parse(built.headerBytes);meta.title='changed';meta.workspaceId='new'
 expect((await lookupSelectedBootstrapStage(path,{kind:'header',meta},io)).kind).toBe('full')
 meta.semanticSeed.manifestDigest='0'.repeat(64)
 expect((await lookupSelectedBootstrapStage(path,{kind:'header',meta},io)).kind).toBe('conflict')
 const other=structuredClone(route);other.request.invocation.operationId='different'
 // An invocation change without a matching digest remains a valid distinct operation.
 expect((await lookupSelectedBootstrapStage(path,{kind:'route',route:other},io)).kind).toBe('conflict')
 await writeFile(paths.promote,built.stageBytes)
 expect((await lookupSelectedBootstrapStage(path,{kind:'route',route},io)).kind).toBe('conflict')
 }finally{await rm(root,{recursive:true,force:true})}
})
it('observes matching full promotion bytes with reservation without granting a full stage',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ih-sel-'));try{
 const path=join(root,'target.jsonl'),{route,reservation,built}=fixture(),paths=selectedBootstrapPaths(path,route)
 await writeFile(paths.stage,encodeSelectedResultsReservation(reservation));await writeFile(paths.promote,built.stageBytes)
 const result=await lookupSelectedBootstrapStage(path,{kind:'route',route},ordinaryStageIO(path))
 expect(result).toMatchObject({kind:'reserved',promotionBytes:Buffer.from(built.stageBytes)})
 }finally{await rm(root,{recursive:true,force:true})}
})
it('rejects duplicate names and does not read expectation getters after entry currentness fails',async()=>{
 const {route}=fixture(),paths=selectedBootstrapPaths('target.jsonl',route),name=paths.stage
 const duplicate={assertCurrent(){},async namespace(){return [name,name]},async read(){throw Error('unexpected')}}
 expect((await lookupSelectedBootstrapStage('target.jsonl',{kind:'route',route},duplicate)).kind).toBe('unavailable')
 let invoked=false;const expectation:any={kind:'route',get route(){invoked=true;return route}}
 expect((await lookupSelectedBootstrapStage('target.jsonl',expectation,{assertCurrent(){throw Error('lost')},async namespace(){return []},async read(){return undefined}})).kind).toBe('unavailable');expect(invoked).toBe(false)
})

it('denies orphan promotion, old reservation and a selected stage under the wrong key',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ih-sel-'));try{
 const path=join(root,'target.jsonl'),{route,built}=fixture(),paths=selectedBootstrapPaths(path,route),io=ordinaryStageIO(path)
 await writeFile(paths.promote,built.stageBytes)
 expect((await lookupSelectedBootstrapStage(path,{kind:'route',route},io)).kind).toBe('unavailable')
 await rm(paths.promote);await writeFile(paths.stage,JSON.stringify({version:1,kind:'semantic-bootstrap-capture',request:route.request})+'\n')
 expect((await lookupSelectedBootstrapStage(path,{kind:'route',route},io)).kind).toBe('unavailable')
 await rm(paths.stage);await writeFile(path+'.bootstrap-'+ 'a'.repeat(64)+'.stage',built.stageBytes)
 expect((await lookupSelectedBootstrapStage(path,{kind:'header',meta:JSON.parse(built.headerBytes)},io)).kind).toBe('conflict')
 }finally{await rm(root,{recursive:true,force:true})}
})
