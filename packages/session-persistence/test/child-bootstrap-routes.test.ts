import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createSessionCoordinator, createControlledJsonlBackend as createJsonlBackend, backendControls, ownedControls } from './helpers/composed.ts'
import * as p from '../src/index.ts'
import { createJsonlBackend as createNativeJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { bootstrapPathsForRoute } from '../../session-persistence-jsonl/src/backend/bootstrap-stage.ts'
import { buildBootstrapHeader } from '../src/coordinator/bootstrap-header.ts'
import { createSession, append, exportConversationSeed } from '@i-harness/core-session'
const readCuts=vi.hoisted(()=>new Map<string,()=>Promise<void>>())
vi.mock('../../session-persistence-jsonl/src/backend/bootstrap-header.ts',async load=>{
 const api=await load<typeof import('../../session-persistence-jsonl/src/backend/bootstrap-header.ts')>()
 return {...api,createBootstrapHeaderBackend:(...args:Parameters<typeof api.createBootstrapHeaderBackend>)=>{
  const backend=api.createBootstrapHeaderBackend(...args),read=backend.readTrackedState
  backend.readTrackedState=async(route,owner)=>{const state=await read(route,owner),id=route.protocol==='public'?route.invocation.targetSessionId:route.request.invocation.targetSessionId,path=args[0](id),cut=readCuts.get(path);if(cut){readCuts.delete(path);await cut()}return state}
  return backend
 }}
})
const roots:string[]=[], coordinators:p.SessionCoordinator[]=[]
afterEach(async()=>{for(const c of coordinators.splice(0))await c.close().catch(()=>{});for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
import { pair, guards } from './child-bootstrap-fixture.ts'
async function setup(root?:string){root??=await mkdtemp(join(tmpdir(),'ih-child-'));if(!roots.includes(root))roots.push(root);const backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(coordinator);return{root,backend,coordinator}}
it('exposes all three child methods only with the complete routed capability',async()=>{
 const {root,backend,coordinator}=await setup();expect(typeof coordinator.inspectChildBootstrapCapture).toBe('function');expect(typeof coordinator.bootstrapChildTargetWithCapture).toBe('function');expect(typeof coordinator.resumeChildTarget).toBe('function')
 for(const missing of ['readState','readCapture','reserveCapture','resolveBirth'] as const){
  const copied={...backend,bootstrapRoutes:{...backend.bootstrapRoutes!}}
  Reflect.deleteProperty(copied.bootstrapRoutes,missing)
  expect(()=>p.createSessionCoordinator(copied,{lock:{enabled:true}})).toThrow('original writable coordinator factory')
  const native=createNativeJsonlBackend(root,{wrap(original){
   const routes={...original.bootstrapRoutes!};Reflect.deleteProperty(routes,missing);original.bootstrapRoutes=routes
  }})
  const c=p.createSessionCoordinator(native,{lock:{enabled:true}});coordinators.push(c)
  expect(c.inspectChildBootstrapCapture).toBeUndefined();expect(c.bootstrapChildTargetWithCapture).toBeUndefined();expect(c.resumeChildTarget).toBeUndefined()
 }
 const defaultOwner=p.createSessionCoordinator(backend);coordinators.push(defaultOwner)
 expect(defaultOwner.inspectChildBootstrapCapture).toBeTypeOf('function');expect(defaultOwner.bootstrapChildTargetWithCapture).toBeTypeOf('function');expect(defaultOwner.resumeChildTarget).toBeTypeOf('function')
 expect(()=>p.createSessionCoordinator(backend,{lock:{enabled:false}})).toThrow(p.SessionLockUnsupportedError)
 for(const missing of ['bootstrapRoutes','settleBootstrapCaptureIO'] as const){
  expect(()=>p.createSessionCoordinator({...backend,[missing]:undefined},{lock:{enabled:true}})).toThrow('original writable coordinator factory')
  const native=createNativeJsonlBackend(root,{wrap(original){original[missing]=undefined}}),c=p.createSessionCoordinator(native,{lock:{enabled:true}});coordinators.push(c)
  expect(c.inspectChildBootstrapCapture).toBeUndefined();expect(c.bootstrapChildTargetWithCapture).toBeUndefined();expect(c.resumeChildTarget).toBeUndefined()
 }
 const reader=p.createReadOnlySessionCoordinator(backend)
 try{expect(reader.access).toBe('read');expect('bootstrapChildTargetWithCapture'in reader).toBe(false)}finally{await reader.close()}
 expect(await readdir(root)).toEqual([])
 const platform=Object.getOwnPropertyDescriptor(process,'platform')!;try{Object.defineProperty(process,'platform',{value:'darwin'});expect(()=>p.createSessionCoordinator(backend,{lock:{enabled:true}})).toThrow('unsupported')}finally{Object.defineProperty(process,'platform',platform)}
})
it('reserves none child before callback, reaches actual READY and resumes through ordinary open',async()=>{
 const {root,coordinator}=await setup(),{request,payload}=pair();let callbacks=0,capturedReservation:Buffer|undefined
 expect(typeof (coordinator as any).inspectChildBootstrapCapture).toBe('function')
 expect(await (coordinator as any).inspectChildBootstrapCapture(request)).toEqual({kind:'absent'})
 const outcome=await (coordinator as any).bootstrapChildTargetWithCapture(request,guards,async()=>{callbacks++;const stages=(await readdir(root)).filter(n=>n.endsWith('.stage'));expect(stages).toHaveLength(1);capturedReservation=await readFile(join(root,stages[0]!));expect(JSON.parse(capturedReservation.toString()).kind).toBe('semantic-bootstrap-child-capture');return payload})
 expect(outcome.kind).toBe('ready');expect(callbacks).toBe(1);expect(outcome.document.view.events[1]).toMatchObject({type:'agent/input/admitted',text:payload.initial!.text})
 const before=await readFile(join(root,'target.jsonl'));await coordinator.close();const cold=await setup(root);await cold.coordinator.openManagedDocument('target');const resumed=await (cold.coordinator as any).resumeChildTarget(request,guards);expect(resumed.kind).toBe('already-ready');expect(resumed.receipt.initial).toMatchObject({inputId:'input',startedAt:1,expiresAt:11});expect(await readFile(join(root,'target.jsonl'))).toEqual(before)
 expect((await cold.coordinator.resumeChildTarget!(request,guards,payload)).kind).toBe('already-ready');expect(await cold.coordinator.resumeChildTarget!(request,guards,{...payload,initial:{...payload.initial!,text:'wrong cached payload'}})).toEqual({kind:'refused',reason:'conflict'})
 const full=await readFile(bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request}).stage),sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
 console.log(JSON.stringify({control:'child none original reservation/birth/current receipt',reservationSHA256:sha(capturedReservation!),stageSHA256:sha(full),birthFrameSHA256:sha(before.subarray(before.indexOf(10)+1)),targetSHA256:sha(before),sourceObservation:JSON.parse(full.toString()).seed.sourceObservation,initialCommitment:request.core.initial,receipt:resumed.receipt,callbacks}))
})
it('refuses every public exact-invocation cross-call before joining a suspended child flight and READY',async()=>{
 const {root,coordinator}=await setup(),{request,payload}=pair(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let callbacks=0
 const first=coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;entered.resolve();await release.promise;return payload})
 let duplicate:typeof first|undefined
 try{
  await Promise.race([entered.promise,first.then(()=>{throw Error('Original child completed before its callback gate')})])
  duplicate=coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;throw Error('duplicate')})
  const publicCore=p.readForkRequestCore({version:1,kind:'session-fork-core',sourceSessionId:'parent',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{}}),publicIntent=p.createBootstrapRequestIntent(publicCore,{kind:'unmanaged'}),publicRequest={invocation:{...request.invocation,requestDigest:publicIntent.requestDigest},core:publicCore,requestIntent:publicIntent.intent}
  const refused=async(operation:Promise<unknown>)=>expect(await Promise.race([operation,new Promise(resolve=>setTimeout(()=>resolve('joined suspended child flight'),100))])).toEqual({kind:'refused',reason:'conflict'})
  await refused(coordinator.bootstrapSemanticTarget(payload,guards));await refused(coordinator.resumeSemanticTarget(request.invocation,guards));await refused(coordinator.bootstrapSemanticTargetWithCapture!(publicRequest,guards,async()=>{throw Error('public callback forbidden')}));expect((await coordinator.inspectBootstrap(request.invocation)).kind).toBe('conflict');expect(await coordinator.inspectBootstrapCapture!(publicRequest)).toEqual({kind:'conflict'});await expect(coordinator.inspectBootstrapCapture!(request as any)).rejects.toThrow()
 }finally{release.resolve();await Promise.allSettled([first,duplicate])}
 if(!duplicate)throw Error('Original duplicate child must be admitted')
 const [a,b]=await Promise.all([first,duplicate]);expect(a.kind).toBe('ready');expect(b).toBe(a);expect(callbacks).toBe(1)
 expect(await coordinator.bootstrapSemanticTarget(payload,guards)).toEqual({kind:'refused',reason:'conflict'});expect(await coordinator.resumeSemanticTarget(request.invocation,guards,payload)).toEqual({kind:'refused',reason:'conflict'})
 await coordinator.close();const cold=await setup(root);expect(await cold.coordinator.bootstrapSemanticTarget(payload,guards)).toEqual({kind:'refused',reason:'conflict'});expect(await cold.coordinator.resumeSemanticTarget(request.invocation,guards)).toEqual({kind:'refused',reason:'conflict'});expect((await cold.coordinator.resumeChildTarget!(request,guards)).kind).toBe('already-ready')
})
it.each([undefined,null,false,0,''])('spends a literal callback failure %s across warm and cold payload/callback retries',async failure=>{
 const {root,coordinator}=await setup(),{request,payload}=pair();let callbacks=0
 const result=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;throw failure}).then(value=>({value}),error=>({error}));expect(Object.hasOwn(result,'error')).toBe(true);expect((result as any).error).toBe(failure)
 const path=bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request}).stage,original=await readFile(path)
 for(const cold of [false,true]){const c=cold?(await(coordinator.close().then(()=>setup(root)))).coordinator:coordinator;expect(await c.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;return payload})).toMatchObject({kind:'blocked',reason:'payload-required'});expect(await c.resumeChildTarget!(request,guards,payload)).toMatchObject({kind:'blocked',reason:'payload-required'});expect(await readFile(path)).toEqual(original)}expect(callbacks).toBe(1)
})
it('matches a real generic positive for the approved long initial text and spends changed callback text',async()=>{
 const text='é'.repeat(131073),{root,coordinator}=await setup(),{request,payload}=pair(text)
 const generic={...payload,invocation:{...payload.invocation,targetSessionId:'generic',operationId:'generic'}}
 const publicReady=await coordinator.bootstrapSemanticTarget(generic,guards);expect(publicReady.kind).toBe('ready')
 const child=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload);expect(child.kind).toBe('ready')
 if(child.kind==='ready'&&publicReady.kind==='ready'){expect(child.document.view.events[1]).toEqual(publicReady.document.view.events[1]);expect(child.receipt.initial).toEqual(publicReady.receipt.initial)}
 const stage=await readFile(bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request}).stage);expect(stage.length).toBeLessThan(10000);expect(stage.toString()).not.toContain(text)
 const changed=pair(text);changed.payload.invocation={...changed.payload.invocation,targetSessionId:'changed'};changed.request=p.captureChildBootstrapCaptureRequest({...changed.request,invocation:changed.payload.invocation});let calls=0
 expect(await coordinator.bootstrapChildTargetWithCapture!(changed.request,guards,async()=>{calls++;return{...changed.payload,initial:{...changed.payload.initial!,text:text+'x'}}})).toEqual({kind:'refused',reason:'manifest-invalid'})
 await expect(readFile(join(root,'changed.jsonl'))).rejects.toMatchObject({code:'ENOENT'});expect(await coordinator.bootstrapChildTargetWithCapture!(changed.request,guards,async()=>{calls++;return changed.payload})).toMatchObject({kind:'blocked',reason:'payload-required'});expect(calls).toBe(1)
})
it.each(['no-header','header-only','complete'] as const)('recovers an exact cold full stage %s using only its original payload where needed',async cut=>{
 const {root,backend,coordinator}=await setup(),{request,payload}=pair(),reservation={version:1 as const,kind:'semantic-bootstrap-child-capture' as const,request},built=buildBootstrapHeader(payload,undefined,undefined,reservation),paths=bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request})
 if(cut==='complete'){expect((await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload)).kind).toBe('ready');await coordinator.close()}
 else if(cut==='header-only'){
  const original=backendControls(backend).original.prepareBootstrapHeader!;let published=false
  backendControls(backend).methods.prepareBootstrapHeader=async(...args)=>{const result=await original(...args);published=result.kind==='committed';return result}
  expect((await coordinator.bootstrapChildTargetWithCapture!(request,{...guards,assertCurrent(){if(published)throw Error('source retired after original header ACK')}},async()=>payload)).kind).toBe('blocked')
  expect(published).toBe(true);await coordinator.close()
 }else await writeFile(paths.stage,built.operation.stageBytes)
 const cold=await setup(root)
 if(cut!=='complete')expect(await cold.coordinator.resumeChildTarget!(request,guards)).toMatchObject({kind:'blocked',reason:'payload-required'})
 const wrong={...payload,initial:{...payload.initial!,text:'changed'}};expect(await cold.coordinator.resumeChildTarget!(request,guards,wrong)).toMatchObject({kind:'refused',reason:'conflict'})
 const result=await cold.coordinator.resumeChildTarget!(request,guards,cut==='complete'?undefined:payload);expect(['ready','already-ready']).toContain(result.kind);expect(await readFile(paths.stage)).toEqual(Buffer.from(built.operation.stageBytes))
})
it('preserves child birth bytes through raw suffix replacement and refuses stale task metadata',async()=>{
 const {root,backend,coordinator}=await setup(),{request,payload}=pair(),ready=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload);expect(ready.kind).toBe('ready');if(ready.kind!=='ready')throw Error('ready required')
 await ready.document.metadata.admit({type:'plan/mode',mode:'on'});await coordinator.close()
 const path=join(root,'target.jsonl'),raw=await readFile(path),end=raw.indexOf(10),body=raw.subarray(end+1),birth=body.subarray(0,body.indexOf(10)+1),loaded=await backend.read('target')
 const suffix=structuredClone(loaded.events);suffix[suffix.length-1]={type:'plan/mode',mode:'off',seq:suffix.length-1};await backend.replaceEvents!('target',suffix)
 expect((await readFile(path)).subarray(end+1,end+1+birth.length)).toEqual(birth)
 const before=await readFile(path);const changed=structuredClone(suffix);(changed[1] as any).text='changed';await expect(backend.replaceEvents!('target',changed)).rejects.toThrow();expect(await readFile(path)).toEqual(before)
 await appendFile(path,'{"torn":');await backend.repair('target');await backend.updateMeta('target',{title:'new title'})
 const cold=await setup(root);await expect(cold.coordinator.openManagedDocument('target')).rejects.toThrow('TASK_TRANSITION_FAILED')
 const after=await readFile(path);expect(after.subarray(after.indexOf(10)+1,after.indexOf(10)+1+birth.length)).toEqual(birth)

})
it('resumes the original child receipt after native suffix facts and a user title update',async()=>{
 const {root,coordinator}=await setup(),{request,payload}=pair(),ready=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload)
 expect(ready.kind).toBe('ready');if(ready.kind!=='ready')throw Error('ready required')
 const path=join(root,'target.jsonl'),before=await readFile(path),body=before.subarray(before.indexOf(10)+1),birth=body.subarray(0,body.indexOf(10)+1)
 await ready.document.metadata.admit({type:'plan/mode',mode:'off'})
 await ready.document.metadata.admit({type:'session/title',title:'new title',source:'user',messageSeqs:[]})
 await coordinator.close()
 const cold=await setup(root),doc=await cold.coordinator.openManagedDocument('target'),result=await cold.coordinator.resumeChildTarget!(request,guards)
 expect(result.kind).toBe('already-ready');if(result.kind!=='already-ready')throw Error('resume required')
 expect(result.document).toBe(doc);expect(result.receipt.completion.key).toEqual(ready.receipt.completion.key);expect(result.receipt.completion.owner).not.toEqual(ready.receipt.completion.owner)
 expect(result.document.view.events.at(-1)).toMatchObject({type:'session/title',title:'new title',source:'user'})
 const after=await readFile(path);expect(after.subarray(after.indexOf(10)+1,after.indexOf(10)+1+birth.length)).toEqual(birth)
})
it('binds existing V1 all/last-turns source data and rejects changed selection without parent transfer',async()=>{
 for(const selection of [{kind:'all'},{kind:'last-turns',count:1}] as const){const {coordinator}=await setup(),source=createSession();append(source,{type:'turn/start'});append(source,{type:'user/message',text:'source'});append(source,{type:'turn/end'});const exported=exportConversationSeed(source,{kind:'session',sessionId:'parent'},selection);if(exported.kind!=='seed')throw Error('V1 export required');const values=pair(),payload={...values.payload,seed:p.compileSemanticSeed(exported)},core={...values.request.core,history:{selection,source:{kind:'session' as const,sessionId:'parent'}}},intent=p.createChildBootstrapRequestIntent(core,{kind:'unmanaged'}),request=p.captureChildBootstrapCaptureRequest({...values.request,core,requestIntent:intent.intent,invocation:{...values.request.invocation,requestDigest:intent.requestDigest}});payload.invocation=request.invocation;const result=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload);expect(result.kind).toBe('ready')}
})
it('none reaches actual READY without reading any parent/history/legacy/CodeStore backend port',async()=>{
 const {backend,coordinator}=await setup(),{request,payload}=pair();let reads=0
 for(const key of ['read','profile','getDocument','readDocumentObserved'] as const){const original=backendControls(backend).original[key];if(original)(backendControls(backend).methods as any)[key]=async(id:string,...args:unknown[])=>{if(id!=='target'){reads++;throw Error('forbidden parent/CodeStore read '+key)}return Reflect.apply(original,backend,[id,...args])}}
 const outcome=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload);expect(outcome.kind).toBe('ready');expect(reads).toBe(0);if(outcome.kind==='ready'){expect(outcome.receipt.seedLength).toBe(0);expect(outcome.receipt.initial).toEqual({inputId:'input',seq:1,startedAt:1,expiresAt:11});expect(outcome.document.view.events).toHaveLength(2)}
})
it('cached child qualification serializes the original prefix and expires it after native append',async()=>{
 const {root,coordinator}=await setup(),{request,payload}=pair(),birth=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload)
 expect(birth.kind).toBe('ready');if(birth.kind!=='ready')throw Error('Original ready birth required');await coordinator.close()
 const cold=await setup(root),document=await cold.coordinator.openManagedDocument('target'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 readCuts.set(join(root,'target.jsonl'),async()=>{entered.resolve();await release.promise})
 const resume=cold.coordinator.resumeChildTarget!(request,guards)
 await entered.promise
 let appended=false
 const work=document.metadata.admit({type:'plan/mode',mode:'on'}).then(result=>{appended=true;return result})
 await Promise.resolve();expect(appended).toBe(false);release.resolve()
 expect((await resume).kind).not.toBe('already-ready')
 const result=await work;expect(result.kind).toBe('committed')
 const current=await cold.coordinator.resumeChildTarget!(request,guards)
 expect(current.kind).toBe('already-ready');if(current.kind!=='already-ready'||result.kind!=='committed')throw Error('Original current result required')
 expect(current.document).toBe(document);expect(current.receipt.completion.owner).toEqual(result.receipt.owner);expect(current.receipt.completion.key).toEqual(birth.receipt.completion.key)
 expect((await cold.backend.read('target')).events.at(-1)).toMatchObject({type:'plan/mode',mode:'on'})
})

it('refuses a changed V1 history selection after reservation and accepts anonymous V1 only without durable lineage',async()=>{
 const source=createSession();append(source,{type:'turn/start'});append(source,{type:'user/message',text:'source'});append(source,{type:'turn/end'})
 const make=(anonymous:boolean)=>{const values=pair(),lineage=anonymous?{origin:'subagent' as const,subagentProtocolVersion:1 as const}:values.request.core.lineage,initial=anonymous?{inputId:'input',text:'original prompt',startedAt:1,expiresAt:11}:values.payload.initial!,payload={...values.payload,lineage,initial},core={...values.request.core,lineage,caller:{kind:'task' as const,taskId:'task',parentSessionId:anonymous?'':'parent'},initial:p.childInitialCommitment(payload),history:{selection:{kind:'all' as const},source:anonymous?{kind:'anonymous' as const}:{kind:'session' as const,sessionId:'parent'}}},intent=p.createChildBootstrapRequestIntent(core,{kind:'unmanaged'}),request=p.captureChildBootstrapCaptureRequest({...values.request,core,requestIntent:intent.intent,invocation:{...values.request.invocation,requestDigest:intent.requestDigest}});payload.invocation=request.invocation;return{payload,request}}
 const changed=make(false),exported=exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'last-turns',count:1});if(exported.kind!=='seed')throw Error('V1 required');changed.payload.seed=p.compileSemanticSeed(exported);const f=await setup();expect(await f.coordinator.bootstrapChildTargetWithCapture!(changed.request,guards,async()=>changed.payload)).toEqual({kind:'refused',reason:'manifest-invalid'});await expect(readFile(join(f.root,'target.jsonl'))).rejects.toMatchObject({code:'ENOENT'})
 const anonymous=make(true),seed=exportConversationSeed(source,{kind:'anonymous'},{kind:'all'});if(seed.kind!=='seed')throw Error('anonymous V1 required');anonymous.payload.seed=p.compileSemanticSeed(seed);const g=await setup();expect((await g.coordinator.bootstrapChildTargetWithCapture!(anonymous.request,guards,async()=>anonymous.payload)).kind).toBe('ready')
})
it('rejects an actual public passive V2 payload after child reservation before any child header',async()=>{
 const {root,coordinator}=await setup(),values=pair();await coordinator.create({sessionId:'parent'});await coordinator.append('parent',[{type:'turn/start'},{type:'user/message',text:'source'},{type:'code/store',version:1,cellId:'cell',sessionId:'parent',writes:[['x',1]]},{type:'code/cell',cellId:'cell',sessionId:'parent',state:'completed'},{type:'turn/end'}]);const document=await coordinator.openManagedDocument('parent'),view=document.view,count=view.events.length,owner={kind:'held-public-fork' as const,sourceSessionId:'parent',view,factOwner:document,assertCurrent(){document.assertReady();if(document.view!==view||view.events.length!==count)throw Error('source changed')}}
 const exported=exportConversationSeed(view,{kind:'session',sessionId:'parent'},{kind:'completed'},{kind:'public-completed-passive',owner});if(exported.kind!=='seed')throw Error('actual public passive V2 required');expect(exported.seed.version).toBe(2)
 const core={...values.request.core,history:{selection:{kind:'all' as const},source:{kind:'session' as const,sessionId:'parent'}}},intent=p.createChildBootstrapRequestIntent(core,{kind:'unmanaged'}),request=p.captureChildBootstrapCaptureRequest({...values.request,core,requestIntent:intent.intent,invocation:{...values.request.invocation,requestDigest:intent.requestDigest}}),payload={...values.payload,invocation:request.invocation,seed:p.compileSemanticSeed(exported)};let calls=0
 expect(await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{calls++;return payload})).toEqual({kind:'refused',reason:'manifest-invalid'});expect(calls).toBe(1);await expect(readFile(join(root,'target.jsonl'))).rejects.toMatchObject({code:'ENOENT'});expect(await coordinator.resumeChildTarget!(request,guards,payload)).toMatchObject({kind:'blocked',reason:'payload-required'})
})
it('retains the actual synced V1 seed cut and completes the original initial tuple from a cold exact payload',async()=>{
 const {root,backend,coordinator}=await setup(),values=pair(),source=createSession();append(source,{type:'turn/start'});append(source,{type:'user/message',text:'source seed cut'});append(source,{type:'turn/end'});const exported=exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'all'});if(exported.kind!=='seed')throw Error('V1 required')
 const core={...values.request.core,history:{selection:{kind:'all' as const},source:{kind:'session' as const,sessionId:'parent'}}},intent=p.createChildBootstrapRequestIntent(core,{kind:'unmanaged'}),request=p.captureChildBootstrapCaptureRequest({...values.request,core,requestIntent:intent.intent,invocation:{...values.request.invocation,requestDigest:intent.requestDigest}}),payload={...values.payload,invocation:request.invocation,seed:p.compileSemanticSeed(exported)};let current=true,calls=0;const appendBatch=ownedControls(backend).originalAppend
 ownedControls(backend).append =async(...args)=>{const result=await appendBatch(...args);if(args[3].key.batchId.endsWith(':seed'))current=false;return result}
 expect(await coordinator.bootstrapChildTargetWithCapture!(request,{...guards,assertCurrent(){if(!current)throw Error('source revoked after actual seed sync')}},async()=>{calls++;return payload})).toMatchObject({kind:'blocked',reason:'source-changed'});const path=join(root,'target.jsonl'),before=await readFile(path),seedFrame=before.subarray(before.indexOf(10)+1);expect(JSON.parse(seedFrame.toString()).batchId).toBe('bootstrap:child:seed');await coordinator.close()
 const cold=await setup(root);expect(await cold.coordinator.resumeChildTarget!(request,guards)).toMatchObject({kind:'blocked',reason:'payload-required'});const ready=await cold.coordinator.resumeChildTarget!(request,guards,payload);expect(ready.kind).toBe('ready');if(ready.kind!=='ready')throw Error('ready required');const after=await readFile(path),body=after.subarray(after.indexOf(10)+1);expect(body.subarray(0,seedFrame.length)).toEqual(seedFrame);expect(ready.receipt.seed!.key.batchId).toBe('bootstrap:child:seed');expect(ready.receipt.initial).toEqual({inputId:'input',seq:payload.seed.records.length+1,startedAt:1,expiresAt:11});expect(calls).toBe(1)
})
it.each(['absent','readState','resolveBirth'] as const)('keeps actual public generic READY and ordinary cached resume with %s route capability',async missing=>{
 const {root,coordinator}=await setup();await coordinator.close()
 const backend=createJsonlBackend(root,original=>{if(missing==='absent')original.bootstrapRoutes=undefined;else (original.bootstrapRoutes as unknown as Record<string,unknown>)[missing]=undefined})
 const c=createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(c);expect(c.bootstrapChildTargetWithCapture).toBeUndefined()
 const {payload}=pair();expect((await c.bootstrapSemanticTarget(payload,guards)).kind).toBe('ready');await c.close()
 const cold=createSessionCoordinator(backend,{lock:{enabled:true}});coordinators.push(cold);await cold.openManagedDocument('target');expect((await cold.resumeSemanticTarget(payload.invocation,guards)).kind).toBe('already-ready');expect((await readdir(root)).filter(n=>n.endsWith('.stage'))).toHaveLength(1)
})
