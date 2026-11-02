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
