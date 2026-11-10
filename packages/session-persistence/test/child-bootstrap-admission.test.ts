import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator, createControlledJsonlBackend as createJsonlBackend, backendControls, ownedControls } from './helpers/composed.ts'
import * as p from '../src/index.ts'
import { pair, guards } from './child-bootstrap-fixture.ts'
import { acquireSessionLock } from '@i-harness/fs-lock'
import { bootstrapPathsForRoute } from '../../session-persistence-jsonl/src/backend/bootstrap-stage.ts'
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return{...fs,open:vi.fn(fs.open),readdir:vi.fn(fs.readdir)}})
vi.mock('@i-harness/fs-lock',async original=>{const locks=await original<typeof import('@i-harness/fs-lock')>();return{...locks,acquireSessionLock:vi.fn(locks.acquireSessionLock)}})
const native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'),nativeAcquire=(await vi.importActual<typeof import('@i-harness/fs-lock')>('@i-harness/fs-lock')).acquireSessionLock
const roots:string[]=[],coordinators:p.SessionCoordinator[]=[]
afterEach(async()=>{vi.restoreAllMocks();vi.mocked(open).mockImplementation(native.open);vi.mocked(readdir).mockImplementation(native.readdir);vi.mocked(acquireSessionLock).mockImplementation(nativeAcquire);for(const c of coordinators.splice(0))await c.close().catch(()=>{});for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function setup(){const root=await mkdtemp(join(tmpdir(),'ih-ca-'));roots.push(root);const backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true},acquireDeadlineMs:40,acquireRetryMs:5});coordinators.push(coordinator);return{root,backend,coordinator}}
it('keeps existing-read without a target mutation exemption and grants only the exact complete fork target',async()=>{
 const {root,coordinator}=await setup(),{request,payload}=pair();await coordinator.create({sessionId:'parent'})
 await coordinator.withExistingSessionBindingObservation!({sessionIds:['parent']},async()=>{
  const core={...request.core,caller:{...request.core.caller,kind:'task' as const,taskId:'task',parentSessionId:'source'},lineage:{...request.core.lineage,parentSession:'source'},initial:{...request.core.initial,parentSessionId:'source'}},intent=p.createChildBootstrapRequestIntent(core,{kind:'unmanaged'}),self={...request,core,requestIntent:intent.intent,invocation:{...request.invocation,targetSessionId:'parent',requestDigest:intent.requestDigest}}
  await expect(coordinator.bootstrapChildTargetWithCapture!(self,guards,async()=>{throw Error('self callback')})).rejects.toMatchObject({reason:'conflict'})
 })
 await coordinator.withSessionBindingObservation!({existingSessionIds:[],target:request.invocation},async observed=>{
  const wrong={...request,invocation:{...request.invocation,operationId:'different'}}
  await expect(coordinator.resumeChildTarget!(wrong,guards)).rejects.toMatchObject({reason:'conflict'})
  expect((await readdir(root)).filter(name=>name.startsWith('target.jsonl'))).toEqual([])
  observed.assertCurrent()
  const outcome=await coordinator.bootstrapChildTargetWithCapture!(request,{...guards,assertCurrent(){observed.assertCurrent()}},async()=>payload);expect(outcome.kind).toBe('ready');observed.assertCurrent()
 })
})
it('revokes and joins an unrelated original target observation before reserving',async()=>{
 const {root,coordinator}=await setup(),{request,payload}=pair(),entered=Promise.withResolvers<p.SessionBindingObservation>(),leave=Promise.withResolvers<void>()
 const observation=coordinator.withSessionBindingObservation!({existingSessionIds:[],target:request.invocation},async observed=>{entered.resolve(observed);await leave.promise})
 const observed=await entered.promise;let callbacks=0;const capture=coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;return payload})
 expect(()=>observed.assertCurrent()).toThrow();expect((await readdir(root)).some(n=>n.endsWith('.stage'))).toBe(false);expect(callbacks).toBe(0);leave.resolve();await expect(observation).rejects.toMatchObject({reason:'revoked'});expect((await capture).kind).toBe('ready')
})
it.each(['capture','resume'] as const)('captures strict %s host descriptors and original receivers before suspended admission',async mode=>{
 const {coordinator}=await setup(),{request,payload}=pair(),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();let calls=0
 const observation=coordinator.withSessionBindingObservation!({existingSessionIds:[],target:request.invocation},async()=>{entered.resolve();await leave.promise});await entered.promise
 const dependency={confirm(){expect(this).toBe(dependency);throw Error('none')},reconcile(){expect(this).toBe(dependency);throw Error('none')}}
 const host:p.BootstrapGuards={dependencies:dependency,assertCurrent(){expect(this).toBe(host);calls++}}
 const prep:p.BootstrapTargetPreparationPort={async confirm(){expect(this).toBe(prep);return{kind:'confirmed'}},async reconcile(){expect(this).toBe(prep);return{kind:'confirmed'}},assertTargetCurrent(){expect(this).toBe(prep)}};host.targetPreparation=prep
 const operation=mode==='capture'?coordinator.bootstrapChildTargetWithCapture!(request,host,async()=>payload):coordinator.resumeChildTarget!(request,host)
 host.assertCurrent=()=>{throw Error('second host lookup')};host.dependencies=new Proxy({} as any,{get(){throw Error('second dependency lookup')}});host.targetPreparation={confirm(){throw Error('second preparation')},reconcile(){throw Error('second preparation')},assertTargetCurrent(){throw Error('second preparation')}} as any
 leave.resolve();await expect(observation).rejects.toMatchObject({reason:'revoked'});const result=await operation;if(mode==='capture'){expect(result.kind).toBe('ready');expect(calls).toBeGreaterThan(0)}else expect(result).toMatchObject({kind:'blocked',reason:'unknown'})
})
it.each(['guard-accessor','dependency-accessor','preparation-accessor','guard-proxy','callback-proxy'] as const)('rejects %s without getter/trap/callback/namespace effects',async mode=>{
 const {root,backend,coordinator}=await setup(),{request,payload}=pair();let traps=0,callbacks=0;const trap=()=>{traps++;throw Error('host trap')};let host:any={...guards},callback:any=async()=>{callbacks++;return payload}
 if(mode==='guard-accessor')Object.defineProperty(host,'assertCurrent',{enumerable:true,get:trap})
 if(mode==='dependency-accessor')host.dependencies=Object.defineProperty({...guards.dependencies},'confirm',{enumerable:true,get:trap})
 if(mode==='preparation-accessor')Object.defineProperty(host,'targetPreparation',{enumerable:true,get:trap})
 if(mode==='guard-proxy')host=new Proxy(host,{ownKeys:trap,get:trap})
 if(mode==='callback-proxy')callback=new Proxy(callback,{apply:trap})
 const rootCheck=vi.spyOn(backendControls(backend).methods,'checkBootstrapCaptureRoot');expect(await coordinator.bootstrapChildTargetWithCapture!(request,host,callback)).toEqual({kind:'refused',reason:'manifest-invalid'});expect(traps).toBe(0);expect(callbacks).toBe(0);expect(rootCheck).not.toHaveBeenCalled();expect(await readdir(root)).toEqual([])
})
it('refuses direct callback self bootstrap/resume/open/close/retire/delete before changing admission',async()=>{
 const {coordinator}=await setup(),{request,payload}=pair();let callbacks=0
 const outcome=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{
  callbacks++;expect(await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload)).toEqual({kind:'refused',reason:'conflict'});expect(await coordinator.resumeChildTarget!(request,guards)).toEqual({kind:'refused',reason:'conflict'});expect(await coordinator.bootstrapSemanticTarget(payload,guards)).toEqual({kind:'refused',reason:'conflict'});expect(await coordinator.resumeSemanticTarget(request.invocation,guards)).toEqual({kind:'refused',reason:'conflict'})
  for(const action of [()=>coordinator.openManagedDocument('target'),()=>coordinator.closeManagedDocument('target'),()=>coordinator.deleteOwnedSession!('target',{documents:[]}),()=>coordinator.close()])await expect(action()).rejects.toMatchObject({reason:'conflict'})
  return payload
 });expect(outcome.kind).toBe('ready');expect(callbacks).toBe(1);await coordinator.withSessionBindingObservation!({existingSessionIds:[],target:{...request.invocation,targetSessionId:'unrelated'}},async observed=>observed.assertCurrent())
})
it.each(['root','namespace','reservation','callback','promotion','confirmation'] as const)('external close joins the original %s flight and revokes new child work',async cut=>{
 const {root,backend,coordinator}=await setup(),{request,payload}=pair(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let paused=false,callbacks=0,closed=false,headerAcknowledged=false
 const pause=async()=>{if(!paused){paused=true;entered.resolve();await release.promise}}
 if(cut==='root'){const original=backendControls(backend).original.checkBootstrapCaptureRoot!;backendControls(backend).methods.checkBootstrapCaptureRoot =async()=>{await pause();return original()}}
 if(cut==='namespace'){const original=backend.bootstrapRoutes!.readCapture;backend.bootstrapRoutes!.readCapture=async(...args)=>{await pause();return original(...args)}}
 if(cut==='reservation'){const original=backend.bootstrapRoutes!.reserveCapture;backend.bootstrapRoutes!.reserveCapture=async(...args)=>{const result=await original(...args);await pause();return result}}
 if(cut==='promotion'){const original=backendControls(backend).original.prepareBootstrapHeader!;backendControls(backend).methods.prepareBootstrapHeader =async(...args)=>{const result=await original(...args);headerAcknowledged=result.kind==='committed';await pause();return result}}
 if(cut==='confirmation'){const original=backendControls(backend).original.confirmBootstrapFrames!;backendControls(backend).methods.confirmBootstrapFrames =async(...args)=>{const result=await original(...args);await pause();return result}}
 const capture=coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;if(cut==='callback')await pause();return payload});await entered.promise
 const closing=coordinator.close().then(()=>{closed=true});expect(await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload)).toMatchObject({kind:'not-issued',reason:'cancelled'});await Promise.resolve();expect(closed).toBe(false)
 release.resolve();const result=await capture;if(cut==='promotion')expect(headerAcknowledged).toBe(true);await closing;expect(result.kind).not.toBe('ready');expect(coordinator.ownerOf('target')).toBe(false);if(['root','namespace','reservation'].includes(cut))expect(callbacks).toBe(0)
 if(cut==='root')expect((await readdir(root)).some(n=>n.endsWith('.stage'))).toBe(false)
})
it.each([undefined,null,false,0,''])('returns inspection facts after original cleanup and preserves callback %s beside independent cleanup failure',async fault=>{
 const {backend,coordinator}=await setup(),{request}=pair(),original=backendControls(backend).original.settleBootstrapCaptureIO!,failure=Error('same owner cleanup'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let cleanupOwner:object|undefined,settles=0
 backendControls(backend).methods.settleBootstrapCaptureIO =async(id,held)=>{cleanupOwner??=held.owner;expect(held.owner).toBe(cleanupOwner);settles++;if(settles===1){entered.resolve();await release.promise}return original(id,held)}
 let done=false;const inspection=coordinator.inspectChildBootstrapCapture!(request).then(value=>{done=true;return value});await entered.promise;expect(done).toBe(false);release.resolve();expect(await inspection).toEqual({kind:'absent'})
 // The capture flight has its own original held owner, distinct from inspection.
 cleanupOwner=undefined;let fail=false;backendControls(backend).methods.settleBootstrapCaptureIO =async(id,held)=>{cleanupOwner??=held.owner;expect(held.owner).toBe(cleanupOwner);if(fail){fail=false;throw failure}return original(id,held)}
 const result=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{fail=true;throw fault}).then(value=>({value}),error=>({error}));expect((result as any).error).toBeInstanceOf(AggregateError);expect((result as any).error.errors).toEqual([fault,failure])
})
it.each(['claim','retire-claim','namespace','reservation-open','inspection-open'] as const)('joins the actual late native %s acquisition and releases the original handles after external close',async cut=>{
 const {root,coordinator}=await setup(),{request,payload}=pair(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let paused=false,callbacks=0,closes=0,acquires=0,releases=0,rawHandle:Awaited<ReturnType<typeof open>>|undefined
 const nativeClaims: Awaited<ReturnType<typeof nativeAcquire>>[] = []
 const pause=async()=>{if(!paused){paused=true;entered.resolve();await release.promise}}
 if(cut==='claim'||cut==='retire-claim')vi.mocked(acquireSessionLock).mockImplementation(async options=>{const lock=await nativeAcquire(options);nativeClaims.push(lock);acquires++;await pause();return{get held(){return lock.held},async release(){releases++;return lock.release()}}})
 if(cut==='namespace')vi.mocked(readdir).mockImplementation((async(...args:any[])=>{const names=await Reflect.apply(native.readdir,undefined,args);await pause();return names}) as typeof readdir)
 if(cut==='inspection-open')await writeFile(bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request}).stage,p.encodeChildBootstrapReservation({version:1,kind:'semantic-bootstrap-child-capture',request}))
 if(cut==='reservation-open'||cut==='inspection-open')vi.mocked(open).mockImplementation(async(...args)=>{const handle=await native.open(...args);if(!String(args[0]).endsWith('.stage')||args[1]!== (cut==='reservation-open'?'wx':'r'))return handle;rawHandle=handle;await pause();return new Proxy(handle,{get(target,key){if(key==='close')return async()=>{closes++;return target.close()};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})})
 const operation=cut==='inspection-open'?coordinator.inspectChildBootstrapCapture!(request):coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;return payload});await entered.promise
 let closed=false;const closing=(cut==='retire-claim'?coordinator.closeManagedDocument('target'):coordinator.close()).then(()=>{closed=true});if(cut==='retire-claim')await expect(coordinator.resumeChildTarget!(request,guards)).rejects.toMatchObject({reason:'conflict'});await Promise.resolve();expect(closed).toBe(false);release.resolve();const result=await operation;await closing;expect(result.kind).not.toBe('ready');expect(result.kind).not.toBe('absent');expect(callbacks).toBe(0);expect(coordinator.ownerOf('target')).toBe(false)
 if(cut==='claim'||cut==='retire-claim'){expect({acquires,releases}).toEqual({acquires:2,releases:2});expect(nativeClaims.every(claim=>claim.held===false)).toBe(true)};if(rawHandle){expect(rawHandle.fd).toBe(-1);expect(closes).toBe(1)}
})
it('retains a real failed read-close handle and original held owner for inspection close retry',async()=>{
 const {root,backend,coordinator}=await setup(),{request}=pair(),stage=bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request}).stage;await writeFile(stage,p.encodeChildBootstrapReservation({version:1,kind:'semantic-bootstrap-child-capture',request}))
 const failure=Error('original native read close failed');let fail=true,closes=0,handle:Awaited<ReturnType<typeof open>>|undefined,owner:object|undefined;const settle=backendControls(backend).original.settleBootstrapCaptureIO!
 backendControls(backend).methods.settleBootstrapCaptureIO =async(id,held)=>{owner??=held.owner;expect(held.owner).toBe(owner);return settle(id,held)}
 vi.mocked(open).mockImplementation(async(...args)=>{const raw=await native.open(...args);if(String(args[0])!==stage||args[1]!=='r')return raw;handle=raw;return new Proxy(raw,{get(target,key){if(key==='close')return async()=>{closes++;if(fail)throw failure;return target.close()};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})})
 await expect(coordinator.inspectChildBootstrapCapture!(request)).rejects.toBeInstanceOf(AggregateError);expect(handle!.fd).toBeGreaterThanOrEqual(0);expect(coordinator.ownerOf('target')).toBe(true);fail=false;await coordinator.close();expect(handle!.fd).toBe(-1);expect(closes).toBeGreaterThanOrEqual(3);expect(coordinator.ownerOf('target')).toBe(false)
})
it('cold full-stage resume fills original initial bytes only after the actual short completion write proves absence',async()=>{
 const {root,backend,coordinator}=await setup(),{request,payload}=pair();let writes=0,callbacks=0,originalBatch:import('@i-harness/core-session').EncodedFactBatch|undefined
 const append=ownedControls(backend).originalAppend;ownedControls(backend).append =async(...args)=>{if(args[3].key.batchId==='bootstrap:child:complete')originalBatch=args[3];return append(...args)}
 vi.mocked(open).mockImplementation(async(...args)=>{const raw=await native.open(...args);if(String(args[0])!==join(root,'target.jsonl')||args[1]!=='r+')return raw;return new Proxy(raw,{get(target,key){if(key==='write')return async(data:Uint8Array,offset:number,length:number,position:number)=>{if(!Buffer.from(data).includes(Buffer.from('"batchId":"bootstrap:child:complete"')))return target.write(data,offset,length,position);writes++;if(writes===1)return target.write(data,offset,Math.floor(length/2),position);throw Error('actual original completion write interrupted')};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})})
 const first=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;return payload});expect(first.kind).toBe('blocked');expect(writes).toBe(2);expect(originalBatch).toBeDefined();const stage=bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request}).stage,originalStage=await readFile(stage);vi.mocked(open).mockImplementation(native.open);await coordinator.close()
 const cold=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}});coordinators.push(cold);expect(await cold.resumeChildTarget!(request,guards)).toMatchObject({kind:'blocked',reason:'payload-required'});const ready=await cold.resumeChildTarget!(request,guards,payload);expect(ready.kind).toBe('ready');if(ready.kind!=='ready')throw Error('ready required');expect(callbacks).toBe(1);expect(ready.receipt.completion.key).toEqual(originalBatch!.key);expect(ready.document.view.events[1]).toMatchObject({type:'agent/input/admitted',inputId:'input',text:payload.initial!.text});const raw=await readFile(join(root,'target.jsonl'));expect(raw.subarray(raw.indexOf(10)+1)).toEqual(Buffer.from(originalBatch!.bytes));expect(await readFile(stage)).toEqual(originalStage)
})
it('retirement and closed/deleted targets refuse child mutation while preserving original target bytes',async()=>{
 const {root,coordinator}=await setup(),{request,payload}=pair(),ready=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>payload);expect(ready.kind).toBe('ready');await coordinator.closeManagedDocument('target');const before=await readFile(join(root,'target.jsonl'))
 await coordinator.deleteOwnedSession!('target',{documents:[]});await expect(coordinator.resumeChildTarget!(request,guards)).rejects.toMatchObject({reason:'deleted'});expect(before.length).toBeGreaterThan(0);expect(await coordinator.inspectChildBootstrapCapture!(request)).toEqual({kind:'unavailable'})
})

it('retains genuinely unknown header acknowledgment until original-owner reconciliation', async () => {
 const {root,backend,coordinator}=await setup(),{request,payload}=pair()
 const prepare=backendControls(backend).original.prepareBootstrapHeader!
 let captures=0,acknowledged=false
 backendControls(backend).methods.prepareBootstrapHeader=async(...args)=>{
   const outcome=await prepare(...args);acknowledged=outcome.kind==='committed'
   return {kind:'unknown'} // The native write completed, but its ACK is lost.
 }
 const first=await coordinator.bootstrapChildTargetWithCapture!(request,guards,async()=>{captures++;return payload})
 expect(acknowledged).toBe(true);expect(first.kind).toBe('blocked')
 expect(coordinator.ownerOf('target')).toBe(true)
 await expect(coordinator.openManagedDocument('target')).rejects.toThrow()
 const stage=await readFile(bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request}).stage)
 const other=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true},acquireDeadlineMs:40,acquireRetryMs:5});coordinators.push(other)
 await expect(other.adoptOwnership('target')).rejects.toThrow()
 backendControls(backend).methods.prepareBootstrapHeader=prepare
 const resumed=await coordinator.resumeChildTarget!(request,guards,payload)
 expect(['ready','already-ready']).toContain(resumed.kind);expect(captures).toBe(1)
 expect(await readFile(bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request}).stage)).toEqual(stage)
})
