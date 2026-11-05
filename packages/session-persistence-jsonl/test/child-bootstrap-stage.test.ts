import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { canonicalJsonData } from '@i-harness/core-session'
import * as p from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { createSessionCoordinator } from './helpers/composed.ts'
import { bootstrapPaths, bootstrapPathsForRoute, lookupBootstrapStage, ordinaryStageIO } from '../src/backend/bootstrap-stage.ts'
import { bootstrapManifest, buildBootstrapHeader } from '../../session-persistence/src/coordinator/bootstrap-header.ts'
import { pair, guards } from '../../session-persistence/test/child-bootstrap-fixture.ts'
const roots:string[]=[],coordinators:p.SessionCoordinator[]=[]
afterEach(async()=>{for(const c of coordinators.splice(0))await c.close().catch(()=>{});for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function setup(){const root=await mkdtemp(join(tmpdir(),'ih-cs-'));roots.push(root);const backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(coordinator);return{root,backend,coordinator}}
async function artifacts(root:string){const names=(await readdir(root)).filter(n=>n.includes('.bootstrap-')||n==='target.jsonl').sort();return Promise.all(names.map(async name=>({name,bytes:(await readFile(join(root,name))).toString('base64')})))}
it('uses the frozen public key and original canonical child hash domain with one selected namespace',()=>{
 const {request}=pair(),path='target.jsonl',pub=bootstrapPaths(path,request.invocation),child=bootstrapPathsForRoute(path,{protocol:'child-v1',request})
 expect(pub.stage).toBe(path+'.bootstrap-'+createHash('sha256').update(canonicalJsonData(request.invocation)).digest('hex')+'.stage')
 expect(child.stage).toBe(path+'.bootstrap-'+createHash('sha256').update('ih.bootstrap.child.path.v1\0'+canonicalJsonData(request.invocation)).digest('hex')+'.stage');expect(child.stage).not.toBe(pub.stage)
})
it.each(['reserved','full','empty','one-byte','common-prefix','torn','future','oversize','child-public-key','public-child-key','reservation-free-child','both-keys','unknown-suffix','orphan-promotion','matching-promotion','different-promotion'] as const)('physical %s child namespace stays exact and never authorizes recapture or generic fallback',async mode=>{
 const {root,backend,coordinator}=await setup(),{request,payload}=pair(),route={protocol:'child-v1' as const,request},path=join(root,'target.jsonl'),paths=bootstrapPathsForRoute(path,route),publicPaths=bootstrapPaths(path,request.invocation),reservation={version:1 as const,kind:'semantic-bootstrap-child-capture' as const,request},bytes=p.encodeChildBootstrapReservation(reservation),built=buildBootstrapHeader(payload,undefined,undefined,reservation),plain=buildBootstrapHeader(payload)
 let stage:Uint8Array|undefined=bytes,location=paths.stage
 if(mode==='full')stage=built.operation.stageBytes
 if(mode==='empty')stage=Buffer.alloc(0)
 if(mode==='one-byte')stage=Buffer.from('{')
 if(mode==='common-prefix')stage=bytes.subarray(0,16)
 if(mode==='torn')stage=built.operation.stageBytes.subarray(0,built.operation.stageBytes.length-1)
 if(mode==='future')stage=Buffer.from(canonicalJsonData({...reservation,version:2})+'\n')
 if(mode==='oversize')stage=Buffer.alloc(262145,32)
 if(mode==='child-public-key')location=publicPaths.stage
 if(mode==='public-child-key'||mode==='reservation-free-child')stage=plain.operation.stageBytes
 if(mode==='orphan-promotion')stage=undefined
 if(stage!==undefined)await writeFile(location,stage)
 if(mode==='both-keys')await writeFile(publicPaths.stage,plain.operation.stageBytes)
 if(mode==='unknown-suffix')await writeFile(path+'.bootstrap-'+ 'f'.repeat(64)+'.future','unknown')
 if(mode==='orphan-promotion'||mode==='matching-promotion')await writeFile(paths.promote,built.operation.stageBytes)
 if(mode==='different-promotion'){const other=pair('other'),otherBuilt=buildBootstrapHeader(other.payload,undefined,undefined,{version:1,kind:'semantic-bootstrap-child-capture',request:other.request});await writeFile(paths.promote,otherBuilt.operation.stageBytes)}
 const before=await artifacts(root),selected=await lookupBootstrapStage(path,{kind:'route',route},ordinaryStageIO(path)),inspection=await coordinator.inspectChildBootstrapCapture!(request)
 if(mode==='reserved'||mode==='matching-promotion'){expect(selected.kind).toBe('reserved');expect(inspection).toEqual({kind:'reserved',reservation})}else if(mode==='full'){expect(selected.kind).toBe('full');expect(inspection).toEqual({kind:'materialized'})}else{expect(['conflict','unavailable']).toContain(selected.kind);expect(['conflict','unavailable']).toContain(inspection.kind)}
 let callbacks=0;const captured=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;return payload});expect(callbacks).toBe(0);expect(captured.kind).not.toBe('ready');expect(await artifacts(root)).toEqual(before)
 const resumed=await coordinator.resumeChildTarget!(request,guards,payload)
 if(mode==='full'){expect(resumed.kind).toBe('ready');expect(await readFile(paths.stage)).toEqual(Buffer.from(built.operation.stageBytes))}else{expect(resumed.kind).not.toBe('ready');expect(await artifacts(root)).toEqual(before)}
 expect((await backend.readBootstrapState!(request.invocation)).kind).not.toBe('absent')
})
it('header birth selection requires one exact canonical child reservation and rejects both keys before ordinary mutation',async()=>{
 const {root,backend,coordinator}=await setup(),{request,payload}=pair(),route={protocol:'child-v1' as const,request},ready=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload);expect(ready.kind).toBe('ready');await coordinator.close()
 const raw=await readFile(join(root,'target.jsonl')),loaded=await backend.read('target'),birth=await backend.bootstrapRoutes!.resolveBirth('target');expect(birth?.route).toEqual(route)
 await writeFile(bootstrapPaths(join(root,'target.jsonl'),request.invocation).stage,buildBootstrapHeader(payload).operation.stageBytes)
 await expect(backend.read('target')).rejects.toThrow();await expect(backend.repair('target')).rejects.toThrow();await expect(backend.updateMeta('target',{title:'forbidden'})).rejects.toThrow();await expect(backend.replaceEvents!('target',loaded.events)).rejects.toThrow();await expect(backend.bootstrapRoutes!.resolveBirth('target')).rejects.toThrow();expect(await readFile(join(root,'target.jsonl'))).toEqual(raw)
})
it('reservation-free public predecessor preserves original stage and birth frames through ordinary replace and private refusal',async()=>{
 const {root,backend,coordinator}=await setup(),{request,payload}=pair(),built=buildBootstrapHeader(payload),path=join(root,'target.jsonl'),paths=bootstrapPaths(path,request.invocation)
 await writeFile(paths.stage,built.operation.stageBytes);const ready=await coordinator.resumeSemanticTarget(request.invocation,guards,payload);expect(ready.kind).toBe('ready');await coordinator.close();const before=await readFile(path),loaded=await backend.read('target');await backend.replaceEvents!('target',loaded.events);expect(await readFile(path)).toEqual(before);expect(await readFile(paths.stage)).toEqual(Buffer.from(built.operation.stageBytes));expect((await backend.bootstrapRoutes!.resolveBirth('target'))?.route).toEqual({protocol:'public',invocation:request.invocation})
})
it('a missing sole child stage cannot turn ordinary reads or suffix mutation into a generic replacement',async()=>{
 const {root,backend,coordinator}=await setup(),{request,payload}=pair(),ready=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload);expect(ready.kind).toBe('ready');if(ready.kind!=='ready')throw Error('ready required')
 const loaded=await backend.read('target'),path=join(root,'target.jsonl'),before=await readFile(path),stage=bootstrapPathsForRoute(path,{protocol:'child-v1',request}).stage,original=await readFile(stage)
 await unlink(stage)
 try{await expect(backend.read('target')).rejects.toThrow();await expect(backend.replaceEvents!('target',loaded.events)).rejects.toThrow();await expect(backend.repair('target')).rejects.toThrow();await expect(backend.updateMeta('target',{title:'forbidden'})).rejects.toThrow();expect((await ready.document.metadata.admit({type:'plan/mode',mode:'on'})).kind).not.toBe('committed');expect(await readFile(path)).toEqual(before)}finally{await writeFile(stage,original)}
})
it('preserves a constructed reservation-free format12 storage fixture through its actual historical initial birth lane and upgrade',async()=>{
 const {root,backend,coordinator}=await setup(),{payload}=pair(),current=buildBootstrapHeader(payload).stage,headerBase={...current.headerBase,formatVersion:12},core={...current,headerBase},header=JSON.parse(current.headerBytes);header.formatVersion=12;header.semanticSeed.manifestDigest=bootstrapManifest(core,payload.seed.records);const stage={...core,headerBytes:canonicalJsonData(header)+'\n'},built=buildBootstrapHeader(payload,stage),path=join(root,'target.jsonl'),paths=bootstrapPaths(path,payload.invocation)
 await writeFile(paths.stage,built.operation.stageBytes);await writeFile(path,built.operation.headerBytes)
 const ready=await coordinator.resumeSemanticTarget(payload.invocation,guards,payload);expect(ready.kind).toBe('ready');await coordinator.close();const raw=await readFile(path),body=raw.subarray(raw.indexOf(10)+1),loaded=await backend.read('target');expect(loaded.version).toBe(13);await backend.replaceEvents!('target',loaded.events);await backend.updateMeta('target',{title:'after storage upgrade'});const after=await readFile(path);expect(after.subarray(after.indexOf(10)+1)).toEqual(body);expect(await readFile(paths.stage)).toEqual(Buffer.from(built.operation.stageBytes));expect((await backend.bootstrapRoutes!.resolveBirth('target'))?.route.protocol).toBe('public')
})
