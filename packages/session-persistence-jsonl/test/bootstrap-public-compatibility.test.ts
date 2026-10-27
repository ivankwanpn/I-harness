import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { append, createSession, exportConversationSeed, type EncodedFactBatch } from '@i-harness/core-session'
import * as p from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { bootstrapPaths } from '../src/backend/bootstrap-stage.ts'

const coordinators:p.SessionCoordinator[]=[]
afterEach(async()=>{for(const c of coordinators.splice(0))await c.close().catch(()=>{})})
const guards:p.BootstrapGuards={assertCurrent(){},dependencies:{async confirm(){throw Error('no artifact dependencies')},async reconcile(){throw Error('no artifact dependencies')}}}
async function setup(label:string){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,label+'-')),backend=createJsonlBackend(root),coordinator=p.createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(coordinator);return{root,backend,coordinator}
}
function payload():p.BootstrapRequest {
 const source=createSession();append(source,{type:'user/message',text:'original source'});const exported=exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'all'});if(exported.kind!=='seed')throw Error('V1 export required')
 return{invocation:{version:1,operationId:'public-recovery',targetSessionId:'target',createdAt:'2026-10-23T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new'},metadata:{title:'original'},lineage:{origin:'fork',parentSession:'parent'},seed:p.compileSemanticSeed(exported),initial:{inputId:'initial',text:'do task once',parentSessionId:'parent',startedAt:100,expiresAt:200}}
}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
async function snapshot(root:string){return Promise.all((await readdir(root)).filter(name=>name.startsWith('target.jsonl')).sort().map(async name=>{const bytes=await readFile(join(root,name));return{name,sha256:sha(bytes),bytes:bytes.toString('base64')}}))}
async function record(root:string,name:string,value:unknown){await writeFile(join(root,name+'.json'),JSON.stringify(value,null,2)+'\n')}
function captureRequest():p.BootstrapCaptureRequest {
 const core=p.readForkRequestCore({version:1,kind:'session-fork-core',sourceSessionId:'parent',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{}}),intent=p.createBootstrapRequestIntent(core,{kind:'unmanaged'})
 return{invocation:{...payload().invocation,requestDigest:intent.requestDigest},core,requestIntent:intent.intent}
}
it('keeps a future promotion unavailable and every original protected byte immutable through public inspection and resume',async()=>{
 const {root,backend,coordinator}=await setup('public-future'),request=captureRequest(),source=createSession();append(source,{type:'turn/start'});append(source,{type:'user/message',text:'public source'});append(source,{type:'turn/end'});const exported=exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'completed'});if(exported.kind!=='seed')throw Error('public source required');const original={...payload(),invocation:request.invocation,metadata:request.core.metadata,seed:p.compileSemanticSeed(exported)};delete original.initial
 expect((await coordinator.bootstrapSemanticTargetWithCapture!(request,guards,async()=>original)).kind).toBe('ready');await coordinator.close();const paths=bootstrapPaths(join(root,'target.jsonl'),request.invocation);await writeFile(paths.promote,'{"version":2,"kind":"future"}\n');const before=await snapshot(root),cold=p.createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(cold)
 const inspection=await cold.inspectBootstrapCapture!(request),resume=await cold.resumeSemanticTarget(request.invocation,guards,original),after=await snapshot(root);await record(root,'outcome',{inspection,resume:{kind:resume.kind,...('reason'in resume?{reason:resume.reason}:{})},before,after});console.log(JSON.stringify({control:'public-future',root,inspection,unchanged:JSON.stringify(before)===JSON.stringify(after)}));expect(inspection).toEqual({kind:'unavailable'});expect(['ready','already-ready']).not.toContain(resume.kind);expect(after).toEqual(before)
})
it('passively confirms the actual synced completion after failed close without new appends or replacing its original owner',async()=>{
 const {root,backend,coordinator}=await setup('public-lost'),request=payload(),appendBatch=backend.appendOwnedBatch!,confirm=backend.confirmBootstrapFrames!;let appends=0,lose=true,heldOwner:object|undefined,appendOwner:object|undefined,original:EncodedFactBatch|undefined
 backend.appendOwnedBatch=async(...args)=>{appends++;const result=await appendBatch(...args);if(args[3].key.batchId.endsWith(':complete')){original=args[3];appendOwner=args[1].owner;if(lose)return{kind:'unknown',key:args[3].key}}return result}
 backend.confirmBootstrapFrames=async(id,held,frames)=>{heldOwner??=held.owner;expect(held.owner).toBe(heldOwner);expect(held.owner).toBe(appendOwner);return confirm(id,held,frames)}
 expect((await coordinator.bootstrapSemanticTarget(request,guards)).kind).toBe('blocked');const before=await snapshot(root);let closeFailed=false;try{await coordinator.close()}catch{closeFailed=true}expect(closeFailed).toBe(true);lose=false;const count=appends
 const outcome=await coordinator.resumeSemanticTarget(request.invocation,{...guards,assertCurrent(){throw Error('passive recovery cannot issue new source work')}}),after=await snapshot(root);await record(root,'outcome',{kind:outcome.kind,...('receipt'in outcome?{receipt:outcome.receipt}:{}),closeFailed,appendsBefore:count,appendsAfter:appends,originalKey:original?.key,before,after});console.log(JSON.stringify({control:'public-lost',root,kind:outcome.kind,closeFailed,appends:count,unchanged:JSON.stringify(before)===JSON.stringify(after)}))
 expect(outcome.kind).toBe('already-ready');if(outcome.kind!=='already-ready')throw Error('actual receipt required');expect(outcome.receipt.completion.key).toEqual(original!.key);expect(outcome.receipt.completion.owner).toEqual(heldOwner);expect(outcome.document.view.events.filter(e=>e.type==='agent/input/admitted')).toHaveLength(1);expect(after).toEqual(before);expect(appends).toBe(count);expect((await outcome.document.metadata.admit({type:'plan/mode',mode:'on'})).kind).toBe('not-issued')
})
it('a new revocation during an already-revoked passive receipt retry still prevents READY',async()=>{
 const {root,backend,coordinator}=await setup('public-revoked-retry'),request=payload(),appendBatch=backend.appendOwnedBatch!,confirm=backend.confirmBootstrapFrames!,entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 backend.appendOwnedBatch=async(...args)=>{const result=await appendBatch(...args);return args[3].key.batchId.endsWith(':complete')?{kind:'unknown',key:args[3].key}:result};expect((await coordinator.bootstrapSemanticTarget(request,guards)).kind).toBe('blocked');await expect(coordinator.close()).rejects.toThrow();backend.appendOwnedBatch=appendBatch
 backend.confirmBootstrapFrames=async(...args)=>{const result=await confirm(...args);entered.resolve();await release.promise;return result};const before=await snapshot(root),retry=coordinator.resumeSemanticTarget(request.invocation,guards);await entered.promise;coordinator.revokeManagedDocumentNewWork('target');release.resolve();const outcome=await retry;await record(root,'outcome',{kind:outcome.kind,before,after:await snapshot(root)});expect(outcome.kind).toBe('blocked');expect(await snapshot(root)).toEqual(before)
})
it.each(['revoke','close','repeat-revoke'] as const)('direct original document %s during receipt confirmation prevents READY',async mode=>{
 const {root,backend,coordinator}=await setup('public-direct-'+mode),request=payload(),ready=await coordinator.bootstrapSemanticTarget(request,guards);expect(ready.kind).toBe('ready');if(ready.kind!=='ready')throw Error('actual document required');const document=ready.document,confirm=backend.confirmBootstrapFrames!,entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 if(mode==='repeat-revoke')coordinator.revokeManagedDocumentNewWork('target')
 backend.confirmBootstrapFrames=async(...args)=>{const result=await confirm(...args);entered.resolve();await release.promise;return result}
 const before=await snapshot(root),retry=coordinator.resumeSemanticTarget(request.invocation,guards);await entered.promise;if(mode==='close')await document.close();else document.revokeNewWork();release.resolve();const outcome=await retry,after=await snapshot(root);await record(root,'outcome',{mode,kind:outcome.kind,before,after});expect(outcome.kind).toBe('blocked');expect(after).toEqual(before)
})
