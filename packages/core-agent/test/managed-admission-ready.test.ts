import { expect, it, vi } from 'vitest';
vi.mock('@i-harness/core-session', async (load) => { const original = await load<typeof import('@i-harness/core-session')>(); return { ...original, createManagedSessionState() { throw Error('Private Agent built a full managed view'); }, projectConversation() { throw Error('Private Agent replayed public conversation'); }, readConversationState() { throw Error('Private Agent replayed public state'); } }; });
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, captureExecutionHookChannel } from '@i-harness/core-plugin';
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin';
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts';
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts';
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts';
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts';
import { createExecutionGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts';
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts';
import { createLoopbackProvider } from './helpers/provider-loopback.ts';
import { createManagedAgent } from '../src/index.ts';
import { createManagedAgentModelOriginOwner } from '../src/tool-batch/model-origin.ts';

const probe=vi.hoisted(()=>({hold:undefined as undefined|(()=>Promise<void>),failClose:false,unknown:false,nativeReads:0,resolves:0,afterUnstartedClose:undefined as undefined|(()=>Promise<void>)}));
vi.mock('../../session-persistence/src/execution-internal.ts',async load=>{
 const original=await load<typeof import('../../session-persistence/src/execution-internal.ts')>();
 return {...original,openExecutionDependencies(...args:Parameters<typeof original.openExecutionDependencies>){
  const scope=original.openExecutionDependencies(...args),hold=probe.hold;probe.hold=undefined;
  return {assertCurrent:scope.assertCurrent.bind(scope),async readEvent(ordinal:number){const event=await scope.readEvent(ordinal);probe.nativeReads++;return event},async close(){if(hold)await hold();if(hold&&probe.failClose)throw undefined;await scope.close()}}
 }}
});
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{
 const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();
 return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const journal=original.createFactJournalBackend(...args),append=journal.appendOwnedBatch;return {...journal,async appendOwnedBatch(...input:Parameters<typeof append>){const outcome=await append(...input);if(probe.unknown&&Buffer.from(input[3].bytes).toString('utf8').includes('admission-writer'))return {kind:'unknown' as const,key:input[3].key};return outcome}}}}
});
import type {ManagedAction,FactOutcome} from '@i-harness/core-session';
import {deferred} from './helpers/provider-loopback.ts';
const wire=()=> 'data: '+JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})+'\n\ndata: [DONE]\n\n';
for(const mode of ['ready','native-read','abort','Stop','falsey-close','unknown'] as const)it(`actual Agent finite admission native close ${mode}`,async()=>{
 probe.failClose=false;probe.unknown=false;probe.hold=undefined;probe.nativeReads=0;
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'admission-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract),{id}=await c.create(),execution=await acquireManagedExecution(c,id),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:id}},origin.verifier);
 const entered=deferred(),release=deferred(),reconciled=deferred(),sent=deferred(),controller=new AbortController();let action:ManagedAction<FactOutcome>,writing:Promise<unknown>|undefined,reconciles=0;
 const received=execution.owner.registerReceivedInputSource(async()=>{});if(mode==='native-read')expect((await received.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'real-read',text:'native original human',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}).admit()).kind).toBe('committed');
 const unrelated=execution.owner.beginAction(),body=deferred(),producer=unrelated.registerSettlementSource(()=>body.promise);
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{sent.resolve();response.end(wire())}]);
 const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:"original admission",budget:{contextWindow:4096},maxOutputTokens:128,
  generationFactory(original,deps){action=original;return createExecutionGenerationLifecycle(execution,id,original,undefined,deps)},
  requestContext:{async reconcile(){if(++reconciles!==1)return;probe.hold=async()=>{entered.resolve();await release.promise};writing=mode==='native-read'?execution.observe().delivery.ownHuman():action.captureMetadata!({type:'session/title',title:'admission-writer',source:'user',messageSeqs:[]}).admit();await entered.promise;reconciled.resolve()},capture(){return undefined},current(e){return e===undefined},retain(){throw Error('No instructions')},managedSucceeded(){return undefined},promotedHumanRequest(){},async close(){}}
 });
 const result=agent.run('actual finite admission',controller.signal).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
 try{
  await Promise.race([reconciled.promise,result.then(out=>{if(!out.ok)throw out.error;throw Error("early run")})]);await new Promise<void>(r=>setImmediate(r));expect(server.requests).toHaveLength(0);
  if(mode==='abort')controller.abort();if(mode==='Stop')action!.stop();if(mode==='falsey-close')probe.failClose=true;if(mode==='unknown')probe.unknown=true;
  release.resolve();await writing;if(mode==='native-read')expect(probe.nativeReads).toBeGreaterThan(0);
  if((mode==='ready'||mode==='native-read')){await Promise.race([sent.promise,result.then(out=>{if(!out.ok)throw out.error;throw Error("no send")})]);expect(server.requests).toHaveLength(1)}
  body.resolve();const outcome=await result;expect(outcome.ok).toBe((mode==='ready'||mode==='native-read'));expect(server.requests).toHaveLength((mode==='ready'||mode==='native-read')?1:0);expect(reconciles).toBe(1);
 }finally{release.resolve();body.resolve();probe.failClose=false;probe.unknown=false;await result;await received.close();await producer.close();unrelated.finish();await c.close().catch(()=>{});await server.close()}
},30000);

// Delegate real settlement and recovery; these probes control scheduling and
// count the unstarted observation, never substitute its original authority.
vi.mock('../src/agent/unstarted-call-settlement.ts',async load=>{
 const original=await load<typeof import('../src/agent/unstarted-call-settlement.ts')>();
 return {...original,createUnstartedCallSettlement(...args:Parameters<typeof original.createUnstartedCallSettlement>){const owner=original.createUnstartedCallSettlement(...args);return {...owner,async close(){await owner.close();const after=probe.afterUnstartedClose;probe.afterUnstartedClose=undefined;await after?.()}}}}
});
vi.mock('../src/agent/recovery.ts',async load=>{
 const original=await load<typeof import('../src/agent/recovery.ts')>();
 return {...original,createRecovery(...args:Parameters<typeof original.createRecovery>){const owner=original.createRecovery(...args);return {...owner,resolve(...input:Parameters<typeof owner.resolve>){probe.resolves++;return owner.resolve(...input)}}}}
});
for(const mode of ['ready','abort','falsey-close'] as const)it(`actual accepted Agent recovery observation waits for finite original writer ${mode}`,async()=>{
 probe.failClose=false;probe.unknown=false;probe.hold=undefined;probe.afterUnstartedClose=undefined;probe.resolves=0;
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'recovery-admission-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract),{id}=await c.create(),execution=await acquireManagedExecution(c,id),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:id}},origin.verifier);
 const entered=deferred(),release=deferred(),boundary=deferred(),controller=new AbortController(),writer=execution.owner.beginAction();let writing:Promise<unknown>|undefined,completed=false;
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire())}]);
 probe.afterUnstartedClose=async()=>{probe.hold=async()=>{entered.resolve();await release.promise};writing=writer.captureMetadata!({type:'session/title',title:'recovery-finite-writer',source:'user',messageSeqs:[]}).admit();await entered.promise;boundary.resolve()};
 const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'actual accepted response',budget:{contextWindow:4096},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,id,action,undefined,deps)});
 const result=agent.run('one actual response',controller.signal).then(value=>{completed=true;return {ok:true as const,value}},error=>{completed=true;return {ok:false as const,error}});
 try{
  await Promise.race([boundary.promise,result.then(out=>{if(!out.ok)throw out.error;throw Error('Early completion')})]);await new Promise<void>(r=>setImmediate(r));expect(server.requests).toHaveLength(1);expect(probe.resolves).toBe(0);expect(completed).toBe(false);
  if(mode==='abort')controller.abort();if(mode==='falsey-close')probe.failClose=true;release.resolve();await writing;const outcome=await result;expect(outcome.ok).toBe(mode==='ready');expect(probe.resolves).toBe(mode==='ready'?1:0);expect(server.requests).toHaveLength(1);
  const events=(await backend.read(id)).events;expect(events.filter(e=>e.type==='model/exchange-accepted')).toHaveLength(1);expect(events.filter(e=>e.type==='assistant/message')).toHaveLength(1);
 }finally{release.resolve();probe.failClose=false;probe.afterUnstartedClose=undefined;await writing;await result;writer.finish();await c.close().catch(()=>{});await server.close()}
},30000);
