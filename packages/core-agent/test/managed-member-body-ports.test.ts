import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({unknownNext:false,appends:0}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{
 const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
 return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const journal=original.createFactJournalBackend(...args),append=journal.appendOwnedBatch;return {...journal,async appendOwnedBatch(...input:Parameters<typeof append>){probe.appends++;const outcome=await append(...input);if(probe.unknownNext&&outcome.kind==='committed'){probe.unknownNext=false;return {kind:'unknown' as const,key:input[3].key}}return outcome}}}}
})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry,capturedManagedExecutionDomain,capturedToolRegistry,type ToolResultRetention} from '@i-harness/core-tools'
import {createManagedExecutionDomain,readManagedActionMembers,assertManagedActionCurrent} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'

async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'member-abi-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract),{id}=await coordinator.create(),execution=await acquireManagedExecution(coordinator,id),ctx=createContext(),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx),action=execution.owner.beginAction();return {coordinator,execution,ctx,domain,action,id}}
it('original same-action ACK membership is passive after Stop and refuses copies and a different real action',async()=>{
 const {coordinator,execution,domain,action}=await fixture(),other=execution.owner.beginAction()
 try{const capture=action.captureToolCall!({type:'tool/call',callId:'actual',name:'read',args:{path:'original'}}),outcome=await capture.admit();if(outcome.kind!=='committed')throw Error('Actual ACK missing')
  const members=readManagedActionMembers(domain,action,capture,outcome);expect(members).toEqual([expect.objectContaining({type:'tool/call',callId:'actual',args:{path:'original'}})])
  expect(()=>readManagedActionMembers(domain,other,capture,outcome)).toThrow();expect(()=>readManagedActionMembers(domain,{...action},capture,outcome)).toThrow();expect(()=>readManagedActionMembers(domain,action,{...capture},outcome)).toThrow();expect(()=>readManagedActionMembers(domain,action,capture,{...outcome})).toThrow()
  action.stop();expect(()=>assertManagedActionCurrent(domain,action)).toThrow();expect(readManagedActionMembers(domain,action,capture,outcome)).toBe(members);action.finish();expect(()=>readManagedActionMembers(domain,action,capture,outcome)).toThrow()
 }finally{action.finish();other.finish();await coordinator.close()}
})
it.each(['getter','no-op','fact-getter'] as const)('fresh original action guard refuses %s without invoking replacement',async mode=>{
 const {coordinator,domain,action}=await fixture();let callbacks=0;const target=mode==='fact-getter'?action.facts.tools:action,key=mode==='fact-getter'?'call':'assertOpen',original=Object.getOwnPropertyDescriptor(target,key)!
 try{assertManagedActionCurrent(domain,action);action.stop();Object.defineProperty(target,key,mode==='no-op'?{...original,value:()=>{callbacks++}}:{configurable:true,enumerable:true,get(){callbacks++;return()=>{}}});expect(()=>assertManagedActionCurrent(domain,action)).toThrow();expect(callbacks).toBe(0);Object.defineProperty(target,key,original);expect(()=>assertManagedActionCurrent(domain,action)).toThrow();expect(callbacks).toBe(0)}finally{Object.defineProperty(target,key,original);action.finish();await coordinator.close()}
})
it('only the original private registry capture associates its actual domain and a foreign source refuses before plan callbacks',async()=>{
 const {coordinator,execution,ctx,domain,action,id}=await fixture(),source=action.registerSettlementSource(async()=>{});let plans=0,effects=0
 const registry=createToolRegistry(ctx,{executionOwner:{kind:'managed-execution',domain,context:ctx,sessionId:id}})
 registry.register({name:'read',description:'actual leaf',inputSchema:{type:'object'},captureNativePlan(){plans++;return {operation:'read',targets:[]}},async execute(){effects++;return 'actual'}})
 const {id:foreignId}=await coordinator.create(),foreignExecution=await acquireManagedExecution(coordinator,foreignId),foreignAction=foreignExecution.owner.beginAction(),foreignSource=foreignAction.registerSettlementSource(async()=>{})
 try{expect(()=>registry.capture({name:'read',args:{}},{settlementSource:foreignSource})).toThrow();expect(plans).toBe(0)
  const call=action.captureToolCall!({type:'tool/call',callId:'actual',name:'read',args:{}}),outcome=await call.admit();if(outcome.kind!=='committed')throw Error('Actual call missing');const event=readManagedActionMembers(domain,action,call,outcome)[0]!;if(event.type!=='tool/call')throw Error('Actual call member absent')
  const capture=registry.capture({name:event.name,args:event.args},{sessionId:id,callId:event.callId,callEventSeq:event.seq,settlementSource:source});expect(capturedManagedExecutionDomain(capture)).toBe(domain);expect(capturedToolRegistry(capture)).toBe(registry);expect(capturedManagedExecutionDomain({...capture})).toBeUndefined();expect(registry.inspectCapture(capture).identity.settlementSource).toBe(source)
  const prepared=await registry.prepareCaptured(capture);await expect(registry.dispatch(prepared)).rejects.toThrow('Original private model member');expect(effects).toBe(0)
  const publicRegistry=createToolRegistry(ctx);publicRegistry.register({name:'read',description:'public',inputSchema:{},async execute(){return 'public'}});expect(capturedManagedExecutionDomain(publicRegistry.capture({name:'read',args:{}}))).toBeUndefined();expect(execution.owner.ownsAction(action)).toBe(true)
 }finally{await source.close();action.finish();await foreignSource.close();foreignAction.finish();await coordinator.close()}
})
it('private preparation refuses an old Session-only retention callback before invoking it',async()=>{
 const {coordinator,ctx,domain,action,id}=await fixture(),source=action.registerSettlementSource(async()=>{});let legacy=0
 const retention:ToolResultRetention={async prepare(){legacy++},capture(){throw Error('Unexpected result capture')},captureSynthetic(){throw Error('Unexpected synthetic capture')}},registry=createToolRegistry(ctx,{executionOwner:{kind:'managed-execution',domain,context:ctx,sessionId:id},resultRetention:retention})
 registry.register({name:'read',description:'actual',inputSchema:{},async execute(){throw Error('Unexpected body')}})
 try{const capture=action.captureToolCall!({type:'tool/call',callId:'actual',name:'read',args:{}}),outcome=await capture.admit();if(outcome.kind!=='committed')throw Error('Original call absent');const event=readManagedActionMembers(domain,action,capture,outcome)[0]!;await expect(registry.prepare({name:'read',args:{}},undefined,{sessionId:id,callId:'actual',callEventSeq:event.seq,settlementSource:source})).rejects.toThrow('original private adapter');expect(legacy).toBe(0)}finally{await source.close();action.finish();await coordinator.close()}
})
it('unknown original CAP never supplies membership and reconciles its same native batch without another append',async()=>{
 const {coordinator,domain,action}=await fixture();probe.appends=0
 try{const capture=action.captureToolCall!({type:'tool/call',callId:'unknown-original',name:'read',args:{}});probe.unknownNext=true;const unknown=await capture.admit();expect(unknown.kind).toBe('unknown');expect(()=>readManagedActionMembers(domain,action,capture,unknown)).toThrow();expect(()=>assertManagedActionCurrent(domain,action)).toThrow();const outcome=await capture.reconcile();if(outcome.kind!=='committed')throw Error('Original reconciliation missing');expect(readManagedActionMembers(domain,action,capture,outcome)[0]).toMatchObject({type:'tool/call',callId:'unknown-original'});expect(probe.appends).toBe(1);assertManagedActionCurrent(domain,action)}finally{probe.unknownNext=false;action.finish();await coordinator.close()}
})
