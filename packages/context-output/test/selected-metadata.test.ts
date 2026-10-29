import { createResultObservationScope,legacyObservationFor } from '../../session-executor/src/lifecycle/result-observation.ts'
import { ContextStore } from '../src/store.ts'
import { it,expect,vi } from 'vitest'
const io=vi.hoisted(()=>({enabled:false,sync:0,writable:0,bodies:0,failClose:0,closeAttempts:0,delay:undefined as Promise<void>|undefined,entered:undefined as (()=>void)|undefined}));vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,readFile:async(...args:Parameters<typeof fs.readFile>)=>{if(io.enabled&&/[\\/]blobs[\\/]/.test(String(args[0])))io.bodies++;return fs.readFile(...args)},open:async(...args:Parameters<typeof fs.open>)=>{const path=String(args[0]);if(io.enabled){if(args[1]!=='r')io.writable++;if(/[\\/]blobs[\\/]/.test(path))io.bodies++}const handle=await fs.open(...args);return new Proxy(handle,{get(target,key){if(key==='sync')return async()=>{if(io.enabled)io.sync++;return target.sync()};if(key==='close'&&path.endsWith('plan.json'))return async()=>{io.closeAttempts++;if(io.delay){const wait=io.delay;io.delay=undefined;io.entered?.();await wait}if(io.failClose>0){io.failClose--;throw Error('close debt')}return target.close()};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})}}})
import { legacyFixture } from './legacy-fork-fixture.ts'
import { acquireSelectedMetadata } from '../src/service.ts'
it('reads a nonempty original inherited plan without holding the shared gate across a yield',async()=>{
 const fixture=await legacyFixture()
 try{
  expect((await fixture.run()).kind).toBe('ready');const observation=await fixture.observation(),index=vi.spyOn(ContextStore.prototype,'ensureIndex'),body=vi.spyOn(ContextStore.prototype,'verifyBody');io.enabled=true;const owner=await acquireSelectedMetadata(fixture.service(),observation)
  const iterator=owner.reader.legacy()[Symbol.asyncIterator](),first=await iterator.next();expect(first.done).toBe(false);expect(first.value?.ref.id).toBe(fixture.visible.id);expect(first.value?.original).toMatchObject({kind:'local',event:'context/result-ref',slot:'ref'})
  expect([io.sync,io.writable,io.bodies]).toEqual([0,0,0]);io.enabled=false;await fixture.service().grant({sessionId:fixture.visible.sessionId},[fixture.visible.id],'target');io.enabled=true;expect((await iterator.next()).done).toBe(true);expect([io.sync,io.writable,io.bodies]).toEqual([0,0,0]);expect(index).not.toHaveBeenCalled();expect(body).not.toHaveBeenCalled();index.mockRestore();body.mockRestore();io.enabled=false;await owner.close()
 }finally{io.enabled=false;await fixture.close()}
})

import { rename,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { recordHash } from '../src/legacy/fork-codec.ts'
it('returns an empty reader for the genuine ordinary source and refuses a forged service',async()=>{
 const fixture=await legacyFixture(),service=fixture.service()
 try{const scopes=createResultObservationScope();await fixture.coordinator().withExistingSessionBindingObservation!({sessionIds:['source']},observation=>scopes.run({sessionId:'source',sessionIds:['source'],observation,document:fixture.document,currentSource(){return {sourceId:fixture.sourceId,readonly:true}},assertHostCurrent(){}},async()=>{const original=legacyObservationFor(scopes.current('source')!),owner=await acquireSelectedMetadata(service,original);expect(await owner.reader.legacy()[Symbol.asyncIterator]().next()).toEqual({done:true,value:undefined});await owner.close();expect(()=>acquireSelectedMetadata({...service},original)).toThrow()}))}finally{io.enabled=false;await fixture.close()}
})
it.each(['missing','partial'] as const)('refuses a %s original inherited plan',async mode=>{
 const f=await legacyFixture();try{expect((await f.run()).kind).toBe('ready');const path=join(f.root,'context-output',createHash('sha256').update('workspace').digest('hex'),'legacy-fork-v1',recordHash('binding',f.request.invocation),'plan.json'),saved=path+'.test-original';await rename(path,saved)
 try{if(mode==='partial')await writeFile(path,'{');await expect(acquireSelectedMetadata(f.service(),await f.observation())).rejects.toThrow()}finally{if(mode==='partial'){const {unlink}=await import('node:fs/promises');await unlink(path)}await rename(saved,path)}
 }finally{await f.close()}
})


it('retains and retries the actual failed plan handle on reader close',async()=>{
 const f=await legacyFixture();try{expect((await f.run()).kind).toBe('ready');const owner=await acquireSelectedMetadata(f.service(),await f.observation()),iterator=owner.reader.legacy()[Symbol.asyncIterator]();io.failClose=2;await expect(iterator.next()).rejects.toThrow('close debt');await expect(owner.close()).rejects.toThrow();await owner.close();expect(io.failClose).toBe(0)}finally{io.failClose=0;await f.close()}
})
it('reopens the original nonempty plan without bootstrapping a write index or scanning bodies',async()=>{
 const f=await legacyFixture();try{expect((await f.run()).kind).toBe('ready');await f.reopen();const observation=await f.observation(),index=vi.spyOn(ContextStore.prototype,'ensureIndex'),body=vi.spyOn(ContextStore.prototype,'verifyBody');io.sync=0;io.writable=0;io.bodies=0;io.enabled=true;const owner=await acquireSelectedMetadata(f.service(),observation),iterator=owner.reader.legacy()[Symbol.asyncIterator]();expect((await iterator.next()).value?.ref.id).toBe(f.visible.id);expect((await iterator.next()).done).toBe(true);expect([io.sync,io.writable,io.bodies]).toEqual([0,0,0]);expect(index).not.toHaveBeenCalled();expect(body).not.toHaveBeenCalled();index.mockRestore();body.mockRestore();io.enabled=false;await owner.close()}finally{io.enabled=false;await f.close()}
})
it('retains original service and handle after failed close and retries it',async()=>{
 const f=await legacyFixture();try{expect((await f.run()).kind).toBe('ready');const owner=await acquireSelectedMetadata(f.service(),await f.observation()),iterator=owner.reader.legacy()[Symbol.asyncIterator]();io.failClose=2;await expect(iterator.next()).rejects.toThrow('close debt');await expect(f.service().close()).rejects.toThrow();expect(io.failClose).toBe(0);await f.service().close()}finally{io.failClose=0;await f.close()}
})


it('joins the original pending iterator step before reader close',async()=>{
 const f=await legacyFixture();try{expect((await f.run()).kind).toBe('ready');const owner=await acquireSelectedMetadata(f.service(),await f.observation()),iterator=owner.reader.legacy()[Symbol.asyncIterator](),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();io.entered=entered.resolve;io.delay=leave.promise
 const next=iterator.next().catch(error=>error);await entered.promise;let closed=false;const closing=owner.close().then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false);leave.resolve();await next;await closing;expect(closed).toBe(true)
 }finally{io.delay=undefined;io.entered=undefined;await f.close()}
})


it('refuses the retained plan after original target grant revocation',async()=>{
 const f=await legacyFixture();try{expect((await f.run()).kind).toBe('ready');const owner=await acquireSelectedMetadata(f.service(),await f.observation()),iterator=owner.reader.legacy()[Symbol.asyncIterator]();await f.service().clear('target');await expect(iterator.next()).rejects.toThrow();await owner.close()}finally{await f.close()}
})
it('retains acquisition cleanup debt in the original service until close retries it',async()=>{
 const f=await legacyFixture();try{expect((await f.run()).kind).toBe('ready');const observation=await f.observation();io.failClose=2;await expect(acquireSelectedMetadata(f.service(),observation)).rejects.toThrow('cleanup unresolved');await expect(acquireSelectedMetadata(f.service(),observation)).rejects.toThrow('cleanup unresolved');await f.service().close();expect(io.failClose).toBe(0)}finally{io.failClose=0;await f.close()}
})
it('joins iterator return and owner close on the same pending original step',async()=>{
 const f=await legacyFixture();try{expect((await f.run()).kind).toBe('ready');const owner=await acquireSelectedMetadata(f.service(),await f.observation()),iterator=owner.reader.legacy()[Symbol.asyncIterator](),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();io.entered=entered.resolve;io.delay=leave.promise
 const next=iterator.next().catch(error=>error);await entered.promise;let returned=false,closed=false;const returning=iterator.return!().then(()=>{returned=true}),closing=owner.close().then(()=>{closed=true});await Promise.resolve();expect(returned).toBe(false);expect(closed).toBe(false);leave.resolve();await next;await returning;await closing;expect(returned&&closed).toBe(true)
 }finally{io.delay=undefined;io.entered=undefined;await f.close()}
})
it('refuses retained metadata once the original canonical grant expires',async()=>{
 const f=await legacyFixture();let clock:ReturnType<typeof vi.spyOn>|undefined
 try{expect((await f.run()).kind).toBe('ready');const owner=await acquireSelectedMetadata(f.service(),await f.observation()),iterator=owner.reader.legacy()[Symbol.asyncIterator]();clock=vi.spyOn(Date,'now').mockReturnValue(f.visible.expiresAt+1);await expect(iterator.next()).rejects.toThrow();clock.mockRestore();clock=undefined;await owner.close()}finally{clock?.mockRestore();await f.close()}
})
