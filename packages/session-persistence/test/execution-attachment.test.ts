import {afterEach,expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({denyView:true,views:0,unknown:false,failInstall:false,appends:0,reconciles:0,path:'',readFailure:false,closeFailure:false,closes:0,reads:0,closeGate:undefined as undefined|{entered():void;wait:Promise<void>}}))
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(...args:Parameters<typeof original.createManagedSessionState>){probe.views++;if(probe.denyView)throw Error('Hidden complete managed view');return original.createManagedSessionState(...args)}}})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const backend=original.createFactJournalBackend(...args);return {...backend,async appendOwnedBatch(...args:Parameters<typeof backend.appendOwnedBatch>){probe.appends++;const outcome=await backend.appendOwnedBatch(...args);return probe.unknown&&outcome.kind==='committed'?{kind:'unknown' as const,key:args[3].key}:outcome},async reconcileOwnedBatch(...args:Parameters<typeof backend.reconcileOwnedBatch>){probe.reconciles++;return backend.reconcileOwnedBatch(...args)}}}}})
vi.mock('../../core-session/src/conversation/state.ts',async load=>{const original=await load<typeof import('../../core-session/src/conversation/state.ts')>();return {...original,createConversationStateIndex(){const index=original.createConversationStateIndex();return {...index,stage(...args:Parameters<typeof index.stage>){const staged=index.stage(...args);return {...staged,commit(){if(probe.failInstall){probe.failInstall=false;throw null}staged.commit()}}}}}}})
vi.mock('node:fs/promises',async load=>{const original=await load<typeof import('node:fs/promises')>();return {...original,async open(...args:Parameters<typeof original.open>){const handle=await original.open(...args);if(String(args[0])===probe.path){const read=handle.read.bind(handle),close=handle.close.bind(handle);handle.read=(async(...args:any[])=>{probe.reads++;if(probe.readFailure)throw undefined;return (read as any)(...args)}) as typeof handle.read;handle.close=async()=>{probe.closes++;if(probe.closeFailure)throw false;await close()}}return handle}}})
vi.mock('../src/execution-internal.ts',async load=>{const original=await load<typeof import('../src/execution-internal.ts')>();return {...original,associateExecutionDependencies(backend:object,open:Parameters<typeof original.associateExecutionDependencies>[1]){original.associateExecutionDependencies(backend,(...args)=>{const scope=open(...args);return Object.freeze({assertCurrent:scope.assertCurrent.bind(scope),readEvent:scope.readEvent.bind(scope),async close(){const gate=probe.closeGate;if(gate){probe.closeGate=undefined;gate.entered();await gate.wait}await scope.close()}})})}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'
import {acquireRestoredContext} from '../src/restored-context-internal.ts'
import {readRestoredConversation} from '@i-harness/core-session/internal/restoration'
import {readAcknowledgedExecutionMembers,isManagedExecutionOwner,retainAcknowledgedExecutionMembers} from '@i-harness/core-session/internal/execution'
import {captureContextSnapshot} from '../../context-engine/src/index.ts'
import {captureRestoredContextSnapshot} from '../../context-engine/src/snapshot/build.ts'
import {taskDocumentOperationsFor} from '../src/task-document-internal.ts'
const coordinators:ReturnType<typeof composeJsonlTaskTransitionCoordinator>[]=[]
afterEach(async()=>{probe.denyView=false;probe.closeGate=undefined;probe.unknown=false;probe.failInstall=false;probe.readFailure=false;probe.closeFailure=false;probe.path='';for(const coordinator of coordinators.splice(0))await coordinator.close();probe.denyView=true;probe.views=0;probe.appends=0;probe.reconciles=0;probe.closes=0})
async function fixture(){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'execution-attachment-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);coordinators.push(coordinator)
 await coordinator.create({sessionId:'owner'});await coordinator.append('owner',[{type:'turn/start'},{type:'user/message',text:'original task'},{type:'step/start'},{type:'tool/call',callId:'original-call',name:'read',args:{path:'original'}}]);const execution=await acquireManagedExecution(coordinator,'owner');probe.appends=0;probe.reconciles=0;return {root,backend,coordinator,execution}
}
it('connects an original private writer and nonresident dependency without a managed full-view fallback',async()=>{
 const acquire=acquireManagedExecution
 expect(acquire).toBeTypeOf('function')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'execution-attachment-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);coordinators.push(coordinator)
 await coordinator.create({sessionId:'owner'})
 await coordinator.append('owner',[{type:'turn/start'},{type:'user/message',text:'original task'},{type:'step/start'},{type:'tool/call',callId:'original-call',name:'read',args:{path:'original'}}])
 const execution=await acquire(coordinator,'owner')
 expect(Object.hasOwn(execution.owner,'view')).toBe(false);expect(isManagedExecutionOwner(execution.identity,execution.owner)).toBe(true)
 expect((await acquire(coordinator,'owner')).owner).toBe(execution.owner)
 const action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{})
 const captured=source.tools.captureResult({type:'tool/result',callId:'original-call',name:'read',output:'actual owned result'})
 const outcome=await captured.admit();expect(outcome.kind).toBe('committed');if(outcome.kind!=='committed')throw Error('Original commit missing')
 const members=readAcknowledgedExecutionMembers(captured,outcome);expect(members).toHaveLength(1);expect(members[0]).toMatchObject({type:'tool/result',seq:outcome.seqs[0],output:'actual owned result'})
 const lease=await execution.prepare(),read=readRestoredConversation(lease,{ownerSessionId:'owner'})
 expect(JSON.stringify(read.projection)).toContain('actual owned result');expect(probe.views).toBe(0)
 const readOnly=await acquireRestoredContext(coordinator,'owner'),shared=await readOnly.prepare();expect(readOnly.identity).toBe(execution.identity);expect(readRestoredConversation(shared,{ownerSessionId:'owner'})).toEqual(read);await shared.settle();expect(probe.views).toBe(0)
 const publicDocument=await coordinator.openManagedDocument!('owner')
 expect(publicDocument).toBe(execution.owner);expect(publicDocument.view).toBeDefined()
 expect(publicDocument.view.events[outcome.seqs[0]!]).toBe(members[0]);expect(publicDocument.view.events).toHaveLength(outcome.receipt.lastSeq+1)
 const input={ownerSessionId:'owner',surface:{systemPrompt:'system',tools:[]}}
 expect(captureRestoredContextSnapshot(lease,input)).toEqual(captureContextSnapshot(publicDocument.view,input));expect(probe.views).toBe(0)
 await lease.settle();await source.close();action.finish()
},20000)
it('keeps original unknown work fenced and reconciles its original batch without another append',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{}),captured=source.tools.captureResult({type:'tool/result',callId:'original-call',name:'read',output:'unknown response'})
 probe.unknown=true;expect((await captured.admit()).kind).toBe('unknown');await expect(execution.prepare()).rejects.toThrow();expect(()=>execution.owner.beginAction()).toThrow();expect(probe.appends).toBe(1)
 probe.unknown=false;const outcome=await captured.reconcile();expect(outcome.kind).toBe('committed');expect(probe.appends).toBe(1);expect(probe.reconciles).toBe(1);expect(readAcknowledgedExecutionMembers(captured,outcome)[0]).toMatchObject({output:'unknown response'});await source.close();action.finish()
},20000)
it('retries a partial original install with the first verified receipt object and no second native append',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{}),captured=source.tools.captureResult({type:'tool/result',callId:'original-call',name:'read',output:'partial original install'})
 probe.failInstall=true;const first=await captured.admit();expect(first.kind).toBe('recovery-required');if(first.kind!=='recovery-required')throw Error('Original install failure absent')
 const outcome=await captured.reconcile();expect(outcome.kind).toBe('committed');if(outcome.kind!=='committed')throw Error('Original install did not resume');expect(outcome.receipt).toBe(first.receipt);expect(probe.appends).toBe(1);expect(probe.reconciles).toBe(0);expect(readAcknowledgedExecutionMembers(captured,outcome)).toHaveLength(1);await source.close();action.finish()
},20000)
it('required original capture members survive optional preparation close and Stop until their own pin releases',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{}),captured=source.tools.captureResult({type:'tool/result',callId:'original-call',name:'read',output:'required late ACK'})
 const lease=await execution.prepare();await lease.settle();execution.revokeNewWork()
 const outcome=await captured.admit();expect(outcome.kind).toBe('committed');const members=readAcknowledgedExecutionMembers(captured,outcome),pin=retainAcknowledgedExecutionMembers(captured,outcome)
 expect(()=>readAcknowledgedExecutionMembers({...captured},outcome)).toThrow();expect(()=>readAcknowledgedExecutionMembers(captured,{...outcome})).toThrow();await source.close();action.finish();expect(pin.members).toBe(members);await expect(execution.prepare()).rejects.toThrow();pin.release();expect(()=>readAcknowledgedExecutionMembers(captured,outcome)).toThrow()
},20000)
it('retains falsey dependency primary and close debt until exact passive cleanup, then retries the same unissued capture',async()=>{
 const {root,execution}=await fixture(),action=execution.owner.beginAction()
 await action.facts.agent.lifecycle({type:'conversation/semantics',version:1,mode:'accepted-exchange-v1'})
 const step=await action.facts.agent.lifecycle({type:'step/start',actionId:'actual-action',attemptId:'actual-attempt'});if(step.kind!=='committed')throw Error('Original step missing')
 const captured=action.captureModelExchange({type:'assistant/message',text:'same unissued capture'},{type:'model/exchange-accepted',version:1,exchangeId:'actual-exchange',actionId:'actual-action',attemptId:'actual-attempt',stepStartSeq:{kind:'prior',seq:step.seqs[0]!,expectedType:'step/start'},assistantSeq:{kind:'group',position:0,expectedType:'assistant/message'},callSeqs:[]});probe.appends=0
 probe.path=join(root,'owner.jsonl');probe.readFailure=true;probe.closeFailure=true
 expect((await captured.admit()).kind).toBe('not-issued');expect(probe.appends).toBe(0);const refused=await execution.prepare().then(()=>{throw Error('Debt published a preparation')},error=>error);expect(refused.cause).toBeInstanceOf(AggregateError);expect(refused.cause.errors).toEqual([undefined,false]);expect(probe.closes).toBe(1)
 probe.closeFailure=false;probe.readFailure=false;await execution.owner.drain();expect(probe.closes).toBe(2)
 const outcome=await captured.admit();expect(outcome.kind).toBe('committed');expect(probe.reads).toBeGreaterThan(1);expect(probe.appends).toBe(1);expect(readAcknowledgedExecutionMembers(captured,outcome)).toHaveLength(2);action.finish()
},20000)
it('expires old preparations on original append while a fresh preparation keeps the new revision',async()=>{
 const {execution}=await fixture(),old=await execution.prepare(),action=execution.owner.beginAction()
 expect((await action.facts.metadata.admit({type:'plan/mode',mode:'on'})).kind).toBe('committed')
 expect(()=>readRestoredConversation(old,{ownerSessionId:'owner'})).toThrow('EXPIRED');const current=await execution.prepare();expect(readRestoredConversation(current,{ownerSessionId:'owner'})).toBeDefined();await old.settle();await current.settle();action.finish()
},20000)
it('refuses metadata-incarnation change during original preparation before native issuance',async()=>{
 const {execution,coordinator}=await fixture(),action=execution.owner.beginAction(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 probe.closeGate={entered:entered.resolve,wait:release.promise};const admitting=action.facts.metadata.admit({type:'plan/mode',mode:'on'});await entered.promise
 const updating=coordinator.updateMeta('owner',{title:'changed original metadata'});release.resolve()
 expect((await admitting).kind).toBe('not-issued');await updating;expect(probe.appends).toBe(0);action.finish();await expect(execution.prepare()).rejects.toThrow()
},20000)
it('keeps a valid coalesced original group when another group has an invalid prior reference',async()=>{
 const {execution}=await fixture(),action=execution.owner.beginAction()
 const [invalid,valid]=await Promise.all([action.facts.tools.dispatch('missing',{kind:'prior',seq:999,expectedType:'tool/call'}),action.facts.metadata.admit({type:'plan/mode',mode:'on'})])
 expect(invalid).toMatchObject({kind:'not-issued',code:'FACT_INVALID_GROUP'});expect(valid.kind).toBe('committed');expect(probe.appends).toBe(1);action.finish()
},20000)
it('the same private producer issues the original LIVE required Task parent pin and late Task lease',async()=>{
 const {execution,coordinator}=await fixture(),action=execution.owner.beginAction(),drained=Promise.withResolvers<void>(),source=action.registerSettlementSource(()=>drained.promise),operations=taskDocumentOperationsFor(coordinator)!
 const parent=await operations.requiredParent(execution.owner,source);operations.assertTaskV3Parent(parent,'owner');expect(()=>operations.parent({...execution.owner})).toThrow()
 try{execution.revokeNewWork();operations.assertTaskV3Parent(parent,'owner');const operation=await operations.begin(parent);try{expect(await operation.observe()).toMatchObject({kind:'present',value:taskDocumentStorageContract.empty()})}finally{await operation.close()}}
 finally{drained.resolve();await source.close();await operations.releaseRequiredParent(parent);action.finish()}
},20000)

it('does not feed a schedule fold until an unknown original write reconciles',async()=>{
 const {createScheduleFoldSink,createAfterScheduleRecord}=await import('../../schedule/src/index.ts')
 let feeds=0
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'schedule-unknown-')),backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:info=>{const sink=createScheduleFoldSink(info);return {...sink,appendValidated(unit,ordinal){feeds++;sink.appendValidated(unit,ordinal)}}}},taskDocumentStorageContract);coordinators.push(coordinator)
 await coordinator.create({sessionId:'owner'});const execution=await acquireManagedExecution(coordinator,'owner'),action=execution.owner.beginAction()
 const record=createAfterScheduleRecord('schedule-1','reminder',60,Date.parse('2026-08-31T10:00:00Z'))
 const captured=action.captureMetadata!({type:'schedule/change',version:1,operation:'create',schedule:record})
 probe.unknown=true;expect((await captured.admit()).kind).toBe('unknown');expect(feeds).toBe(0);expect(()=>execution.observe()).toThrow()
 probe.unknown=false;expect((await captured.reconcile()).kind).toBe('committed');expect(feeds).toBe(1)
 expect(execution.observe().schedules).toMatchObject({kind:'available',snapshot:{active:[record]}})
 action.finish()
})

it('signals original readiness only after a held writer dependency closes, even when subscribed while busy',async()=>{
 const {execution}=await fixture(),ctx={}
 const core=await import('@i-harness/core-session/internal/execution'),domain=core.createManagedExecutionDomain(execution.identity,execution.owner,ctx)
 const action=execution.owner.beginAction(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 probe.closeGate={entered:entered.resolve,wait:release.promise}
 const captured=action.captureMetadata!({type:'session/title',title:'ready-test',source:'user',messageSeqs:[]}),write=captured.admit()
 let calls=0,off:(()=>void)|undefined
 try{
  await entered.promise
  const subscribe=Reflect.get(core,'subscribeManagedExecutionReadiness');expect(subscribe).toBeTypeOf('function')
  off=subscribe(domain,()=>{calls++})
  expect(calls).toBe(0);release.resolve();expect((await write).kind).toBe('committed')
  expect(calls).toBeGreaterThan(0);expect(execution.observe().eventCount).toBeGreaterThan(0)
 }finally{release.resolve();await write.catch(()=>{});off?.();action.finish()}
},20000)

it('does not announce readiness for unknown original commit until its same capture reconciles',async()=>{
 const {execution}=await fixture(),ctx={}
 const core=await import('@i-harness/core-session/internal/execution'),domain=core.createManagedExecutionDomain(execution.identity,execution.owner,ctx)
 const subscribe=Reflect.get(core,'subscribeManagedExecutionReadiness');expect(subscribe).toBeTypeOf('function')
 let calls=0;const off=subscribe(domain,()=>{calls++});calls=0
 const action=execution.owner.beginAction(),capture=action.captureMetadata!({type:'session/title',title:'unknown-ready',source:'user',messageSeqs:[]})
 try{probe.unknown=true;expect((await capture.admit()).kind).toBe('unknown');const before=calls;expect(()=>execution.observe()).toThrow();await Promise.resolve();expect(calls).toBe(before);probe.unknown=false;expect((await capture.reconcile()).kind).toBe('committed');expect(calls).toBeGreaterThan(before)}
 finally{probe.unknown=false;off();action.finish()}
},20000)

it('isolates listener failures and refuses foreign or retired original readiness domains',async()=>{
 const {execution}=await fixture(),ctx={}
 const core=await import('@i-harness/core-session/internal/execution'),domain=core.createManagedExecutionDomain(execution.identity,execution.owner,ctx)
 const subscribe=Reflect.get(core,'subscribeManagedExecutionReadiness');expect(subscribe).toBeTypeOf('function')
 expect(()=>subscribe({...domain},()=>{})).toThrow()
 let calls=0;const off=subscribe(domain,()=>{calls++;throw Error('listener fault')});calls=0
 const action=execution.owner.beginAction(),capture=action.captureMetadata!({type:'session/title',title:'safe-ready',source:'user',messageSeqs:[]})
 try{expect((await capture.admit()).kind).toBe('committed');expect(calls).toBeGreaterThan(0);off();off();execution.revokeNewWork();expect(()=>subscribe(domain,()=>{})).toThrow()}
 finally{off();action.finish()}
},20000)

it('retains readiness silence across failed exact dependency cleanup and signals after original retry',async()=>{
 const {root,execution}=await fixture(),action=execution.owner.beginAction()
 await action.facts.agent.lifecycle({type:'conversation/semantics',version:1,mode:'accepted-exchange-v1'})
 const step=await action.facts.agent.lifecycle({type:'step/start',actionId:'readiness-action',attemptId:'readiness-attempt'});if(step.kind!=='committed')throw Error('Original step missing')
 const core=await import('@i-harness/core-session/internal/execution'),domain=core.createManagedExecutionDomain(execution.identity,execution.owner,{})
 const subscribe=Reflect.get(core,'subscribeManagedExecutionReadiness');expect(subscribe).toBeTypeOf('function');let calls=0;const initial=Promise.withResolvers<void>(),unavailable=Promise.withResolvers<{error:unknown;terminal:boolean}>();const off=subscribe(domain,()=>{calls++;initial.resolve()},(error:unknown,terminal:boolean)=>unavailable.resolve({error,terminal}));await initial.promise;calls=0
 const capture=action.captureModelExchange({type:'assistant/message',text:'readiness cleanup'},{type:'model/exchange-accepted',version:1,exchangeId:'readiness-exchange',actionId:'readiness-action',attemptId:'readiness-attempt',stepStartSeq:{kind:'prior',seq:step.seqs[0]!,expectedType:'step/start'},assistantSeq:{kind:'group',position:0,expectedType:'assistant/message'},callSeqs:[]})
 try{
  probe.path=join(root,'owner.jsonl');probe.readFailure=true;probe.closeFailure=true
  expect((await capture.admit()).kind).toBe('not-issued');expect(calls).toBe(0);expect(await unavailable.promise).toMatchObject({error:{errors:[undefined,false]},terminal:false})
  const lateFailure=Promise.withResolvers<{error:unknown;terminal:boolean}>(),lateReady=Promise.withResolvers<void>()
  const lateOff=subscribe(domain,()=>lateReady.resolve(),(error:unknown,terminal:boolean)=>lateFailure.resolve({error,terminal}))
  try{expect(await lateFailure.promise).toMatchObject({error:{errors:[undefined,false]},terminal:false});probe.closeFailure=false;probe.readFailure=false;await execution.owner.drain();await lateReady.promise;expect(calls).toBeGreaterThan(0)}finally{lateOff()}
 }finally{probe.closeFailure=false;probe.readFailure=false;off();action.finish()}
},20000)

it('coalesces a queued ready edge through a busy reader and permits listener-triggered new work',async()=>{
 const {execution}=await fixture(),core=await import('@i-harness/core-session/internal/execution')
 const action=execution.owner.beginAction()
 await action.facts.inputs.admit({type:'agent/input/admitted',version:1,inputId:'ready-edge-input',text:'edge',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
 const observation=execution.observe(),domain=core.createManagedExecutionDomain(execution.identity,execution.owner,{})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();probe.closeGate={entered:entered.resolve,wait:release.promise}
 let calls=0,created:Promise<unknown>|undefined
 const started=Promise.withResolvers<void>(),twice=Promise.withResolvers<void>()
 const off=core.subscribeManagedExecutionReadiness(domain,()=>{calls++;if(!created){created=action.facts.metadata.admit({type:'session/title',title:'listener-work',source:'user',messageSeqs:[]});started.resolve()}else twice.resolve()})
 const read=observation.inbox.admitted('ready-edge-input')
 try{
  await entered.promise;expect(calls).toBe(0);release.resolve();await read
  await started.promise;expect(created).toBeDefined();await created
  await twice.promise
  expect(calls).toBeGreaterThanOrEqual(2);expect(execution.observe().eventCount).toBeGreaterThan(0)
 }finally{release.resolve();await read.catch(()=>{});if(created)await created.catch(()=>{});off();action.finish()}
},20000)

it('notifies a held readiness subscriber of original metadata invalidation',async()=>{
 const {execution,coordinator}=await fixture(),core=await import('@i-harness/core-session/internal/execution'),domain=core.createManagedExecutionDomain(execution.identity,execution.owner,{})
 const action=execution.owner.beginAction(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),failed=Promise.withResolvers<{error:unknown;terminal:boolean}>()
 probe.closeGate={entered:entered.resolve,wait:release.promise}
 const writing=action.facts.metadata.admit({type:'plan/mode',mode:'on'});await entered.promise
 const off=core.subscribeManagedExecutionReadiness(domain,()=>{},(error,terminal)=>failed.resolve({error,terminal}))
 try{const updating=coordinator.updateMeta('owner',{title:'invalidated while waiting'});release.resolve();await writing;await updating;expect(await failed.promise).toMatchObject({error:{code:'FACT_RECOVERY_REQUIRED'},terminal:true})}
 finally{release.resolve();await writing.catch(()=>{});off();action.finish()}
},20000)

it('settles a readiness subscriber on original owner Stop',async()=>{
 const {execution}=await fixture(),core=await import('@i-harness/core-session/internal/execution'),domain=core.createManagedExecutionDomain(execution.identity,execution.owner,{})
 const stopped=Promise.withResolvers<{error:unknown;terminal:boolean}>(),off=core.subscribeManagedExecutionReadiness(domain,()=>{},(error,terminal)=>stopped.resolve({error,terminal}))
 try{execution.revokeNewWork();expect(await stopped.promise).toMatchObject({error:{code:'FACT_CLOSED'},terminal:true})}finally{off()}
},20000)

it('reports an original falsey fold failure after a busy dependency clears',async()=>{
 const {createScheduleFoldSink}=await import('../../schedule/src/index.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'readiness-fold-failure-')),backend=createJsonlBackend(root);let fail=false
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:info=>{const sink=createScheduleFoldSink(info);return {...sink,snapshot(prefix){if(fail)throw false;return sink.snapshot(prefix)}}}},taskDocumentStorageContract);coordinators.push(coordinator);await coordinator.create({sessionId:'owner'})
 const execution=await acquireManagedExecution(coordinator,'owner'),core=await import('@i-harness/core-session/internal/execution'),domain=core.createManagedExecutionDomain(execution.identity,execution.owner,{})
 const action=execution.owner.beginAction(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),unavailable=Promise.withResolvers<{error:unknown;terminal:boolean}>()
 probe.closeGate={entered:entered.resolve,wait:release.promise}
 const writing=action.facts.metadata.admit({type:'plan/mode',mode:'on'});await entered.promise
 const off=core.subscribeManagedExecutionReadiness(domain,()=>{},(error,terminal)=>unavailable.resolve({error,terminal}))
 try{fail=true;release.resolve();await writing;expect(await unavailable.promise).toEqual({error:false,terminal:true})}
 finally{fail=false;release.resolve();await writing.catch(()=>{});off();action.finish()}
},20000)
