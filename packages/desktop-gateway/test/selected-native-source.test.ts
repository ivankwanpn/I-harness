import { it,expect,vi } from 'vitest'
import { mkdtemp,mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
it('retains the actual binding, project, result and metadata reader across two uses',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'native-selected-')),workspace=join(root,'w');await mkdir(workspace);const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}}),projects=createProjectScopeBroker(coordinator,workspace)
 await coordinator.create({sessionId:'source'});const runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'storage'),coordinator,projectFor:projects.nativeScopeFor,resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,retainSelectedProjectRead:projects.retainSelectedBindingRead,contextConfig:{enabled:true}})
 try{const source=await runtime.acquireSelectedSourceObservation('source'),reader=source.inherited,flush=vi.spyOn(coordinator,'flush'),profile=vi.spyOn(coordinator,'profile');let first:unknown,second:unknown;const gate=Promise.withResolvers<void>();let escaped!:Promise<void>;await source.use(async()=>{escaped=(async()=>{await gate.promise;source.inherited.assertCurrent()})();first=runtime.observations.current('source');expect((await source.inherited.legacy()[Symbol.asyncIterator]().next()).done).toBe(true)});await source.use(async()=>{second=runtime.observations.current('source')});expect(second).toBe(first);expect(source.inherited).toBe(reader);expect(flush).not.toHaveBeenCalled();expect(profile).not.toHaveBeenCalled();flush.mockRestore();profile.mockRestore();expect(()=>source.inherited.assertCurrent()).toThrow('expired');gate.resolve();await expect(escaped).rejects.toThrow('expired');const document=await coordinator.openManagedDocument('source'),write=document.metadata.enterPlan('changed');await write;expect(()=>source.assertCurrent()).toThrow();await source.close()}finally{await runtime.close();await projects.close();await coordinator.close()}
})
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
it('reads a genuine nonempty inherited plan from the native original service',async()=>{
 const f=await createGatewayForkFixture();try{await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'legacy',label:'x',text:'retained',complete:true,source});if(!ref)throw Error('capture failed')
 await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'question'},{type:'context/result-ref',ref},{type:'turn/end'}]);const operation=await f.prepare('source','target','native-selected-nonempty'),outcome=await f.execute(operation);expect(outcome.kind).toBe('ready')
 const selected=await f.runtime.acquireSelectedSourceObservation('target');let first:unknown,second:unknown;await selected.use(async()=>{first=f.runtime.observations.current('target');const iterator=selected.inherited.legacy()[Symbol.asyncIterator](),row=await iterator.next();expect(row.done).toBe(false);expect(row.value?.ref.id).toBe(ref.id);await f.runtime.contextOutput.grant({sessionId:'source'},[ref.id],'target');expect((await iterator.next()).done).toBe(true)});await selected.use(async()=>{second=f.runtime.observations.current('target')});expect(second).toBe(first);await selected.close()
 }finally{await f.close()}
})



it('revokes a native source synchronously and drains its active use on project reference change',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'native-selected-drain-')),workspace=join(root,'w');await mkdir(workspace);const coordinator=createSessionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}}),projects=createProjectScopeBroker(coordinator,workspace)
 await coordinator.create({sessionId:'source'});const runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'storage'),coordinator,projectFor:projects.nativeScopeFor,resultReadScopeFor:projects.resultReadScopeFor,withBindingObservation:projects.withBindingObservation,retainSelectedProjectRead:projects.retainSelectedBindingRead,contextConfig:{enabled:true}})
 try{const source=await runtime.acquireSelectedSourceObservation('source'),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>(),active=source.use(async()=>{entered.resolve();await leave.promise}).catch(error=>error);await entered.promise;const changed=projects.configureReferences([]);expect(()=>source.assertCurrent()).toThrow();let done=false;const closing=source.close().then(()=>{done=true});await Promise.resolve();expect(done).toBe(false);leave.resolve();await active;await closing;await changed;expect(done).toBe(true)}finally{await runtime.close();await projects.close();await coordinator.close()}
})
