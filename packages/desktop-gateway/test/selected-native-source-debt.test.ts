import { it,expect,vi } from 'vitest'
import { mkdtemp,mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireSessionLock } from '@i-harness/fs-lock'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
import { setImmediate as turn } from 'node:timers/promises'
vi.mock('@i-harness/fs-lock',async original=>{const fs=await original<typeof import('@i-harness/fs-lock')>();return {...fs,acquireSessionLock:vi.fn(fs.acquireSessionLock)}})
it('retains failed original binding cleanup from a partial native acquisition until runtime close',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'native-source-debt-')),workspace=join(root,'w');await mkdir(workspace);const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}});await coordinator.create({sessionId:'source'});const projects=createProjectScopeBroker(coordinator,workspace,async()=>{throw Error('source denied')}),runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'storage'),coordinator,projectFor:projects.nativeScopeFor,resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,retainSelectedProjectRead:projects.retainSelectedBindingRead,contextConfig:{enabled:true}})
 const native=await vi.importActual<typeof import('@i-harness/fs-lock')>('@i-harness/fs-lock');let failures=2,attempts=0
 vi.mocked(acquireSessionLock).mockImplementation(async options=>{const lock=await native.acquireSessionLock(options);return {get held(){return lock.held},async release(){attempts++;if(failures){failures--;throw Error('original lock debt')}await lock.release()}}})
 try{await expect(runtime.acquireSelectedSourceObservation('source')).rejects.toThrow();expect(failures).toBe(0);expect(()=>runtime.acquireSelectedSourceObservation('source')).toThrow('cleanup unresolved');await runtime.close();expect(attempts).toBeGreaterThanOrEqual(3)}finally{vi.mocked(acquireSessionLock).mockImplementation(native.acquireSessionLock);await runtime.close();await projects.close();await coordinator.close()}
})

it('refuses native self-close from real visibility before poisoning acquisition or later uses',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'native-self-close-')),workspace=join(root,'w');await mkdir(workspace);const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}});await coordinator.create({sessionId:'source'})
 let runtime!:Awaited<ReturnType<typeof createNativeContextRuntime>>,first=true,self:unknown
 const projects=createProjectScopeBroker(coordinator,workspace,async()=>{if(first){first=false;self=await Promise.race([runtime.close().catch(error=>error),turn().then(()=> 'pending')])}return true})
 runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'storage'),coordinator,projectFor:projects.nativeScopeFor,resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,retainSelectedProjectRead:projects.retainSelectedBindingRead,contextConfig:{enabled:true}})
 try{const source=await runtime.acquireSelectedSourceObservation('source');expect(self).toBeInstanceOf(Error);await source.use(async()=>{await expect(runtime.close()).rejects.toThrow('self-close');const go=Promise.withResolvers<void>();let escaped!:Promise<unknown>;await source.use(async()=>{escaped=(async()=>{await go.promise;return runtime.close().catch(error=>error)})()});go.resolve();expect(await escaped).toMatchObject({message:'Native selected source self-close'})});source.assertCurrent();await source.close();const next=await runtime.acquireSelectedSourceObservation('source');await next.close()}finally{await runtime.close();await projects.close();await coordinator.close()}
})

it.each(['core','code'] as const)('retries failed original %s shutdown after selected sources have drained',async phase=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'native-close-retry-')),workspace=join(root,'w');await mkdir(workspace);const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}}),projects=createProjectScopeBroker(coordinator,workspace),runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'storage'),coordinator,projectFor:projects.nativeScopeFor,resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,retainSelectedProjectRead:projects.retainSelectedBindingRead,contextConfig:{enabled:true}})
 await coordinator.create({sessionId:'source'});const source=await runtime.acquireSelectedSourceObservation('source');source.assertCurrent()
 const service=phase==='core'?runtime.contextOutput:runtime.codeRetrieval,close=service.close.bind(service);let attempts=0;const spy=vi.spyOn(service,'close').mockImplementation(async()=>{if(++attempts===1)throw Error('original shutdown failed');await close()})
 const other=vi.spyOn(phase==='core'?runtime.codeRetrieval:runtime.contextOutput,'close'),cancel=vi.spyOn(runtime.codeRetrieval,'cancel')
 try{await expect(runtime.close()).rejects.toThrow('original shutdown failed');await runtime.close();expect(attempts).toBe(2);await runtime.close();expect(attempts).toBe(2);expect(other).toHaveBeenCalledTimes(1);expect(cancel).toHaveBeenCalledTimes(1)}finally{spy.mockRestore();other.mockRestore();cancel.mockRestore();await runtime.close();await projects.close();await coordinator.close()}
})

it('fences another queued acquisition after original cleanup debt appears',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'native-source-debt-race-')),workspace=join(root,'w');await mkdir(workspace);const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}});await coordinator.create({sessionId:'source'});await coordinator.create({sessionId:'other'});const projects=createProjectScopeBroker(coordinator,workspace,async id=>{if(id==='source')throw Error('source denied');return true}),runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'storage'),coordinator,projectFor:projects.nativeScopeFor,resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,retainSelectedProjectRead:projects.retainSelectedBindingRead,contextConfig:{enabled:true}})
 const native=await vi.importActual<typeof import('@i-harness/fs-lock')>('@i-harness/fs-lock');let failures=2;vi.mocked(acquireSessionLock).mockImplementation(async options=>{const lock=await native.acquireSessionLock(options);return {get held(){return lock.held},async release(){if(failures){failures--;throw Error('original lock debt')}await lock.release()}}})
 const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>(),flush=coordinator.flush.bind(coordinator),spy=vi.spyOn(coordinator,'flush').mockImplementation(async id=>{if(id==='other'){entered.resolve();await leave.promise}return flush(id)})
 try{const other=runtime.acquireSelectedSourceObservation('other').catch(error=>error);await entered.promise;await expect(runtime.acquireSelectedSourceObservation('source')).rejects.toThrow();leave.resolve();expect(await other).toBeInstanceOf(Error);await runtime.close()}finally{leave.resolve();spy.mockRestore();vi.mocked(acquireSessionLock).mockImplementation(native.acquireSessionLock);await runtime.close();await projects.close();await coordinator.close()}
})
