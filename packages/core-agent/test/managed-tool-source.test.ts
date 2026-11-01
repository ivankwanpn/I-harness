import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel,onExecutionEvent} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {capturedManagedExecutionDomain} from '@i-harness/core-tools'
import {readManagedActionMembers,subscribeManagedExecution,assertManagedActionCurrent} from '@i-harness/core-session/internal/execution'
import type {FactOutcome,CapturedActionFact,SessionEvent} from '@i-harness/core-session'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createManagedAgentModelOriginOwner,consumeManagedAgentModelOrigin,createManagedModelInvocation} from '../src/tool-batch/managed-model-origin.ts'
import {createManagedBatchSource} from '../src/tool-batch/managed-source.ts'
import {executeToolCalls} from '../src/execute-tool-calls.ts'

it.each(['healthy','stop','copied-call','foreign-action','mutated-call','twice','falsey-body'] as const)('private rolling pool requires original same-action accepted members (%s)',async(mode)=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-tool-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract),{id}=await coordinator.create(),execution=await acquireManagedExecution(coordinator,id),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution)
 let effects=0,post=0;onExecutionEvent(ctx,'agent/post-tool',()=>{post++})
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:id}},origin.verifier)
 pair.registry.register({name:'read_probe',description:'real leaf',inputSchema:{type:'object'},async execute(_args,exec){expect(exec.session).toBeUndefined();effects++;if(mode==='falsey-body')throw undefined;return 'real'}})
 const binding=origin.bind(pair.registry,pair.driver),state=consumeManagedAgentModelOrigin(binding,origin.domain,pair.registry),action=execution.owner.beginAction(),invocation=createManagedModelInvocation(state,action),sources=new Set<ReturnType<typeof action.registerSettlementSource>>()
 const admit=async(capture:CapturedActionFact<FactOutcome>)=>{const outcome=await capture.admit();if(outcome.kind!=='committed')throw Error(`Expected actual ACK: ${outcome.kind}`);return {capture,outcome}}
 const received:SessionEvent[]=[];const unsubscribe=subscribeManagedExecution(origin.domain,event=>received.push(event))
 try{
  expect(()=>createManagedModelInvocation({...state},action)).toThrow();expect(Object.isFrozen(state)).toBe(true)
  await admit(action.captureLifecycle!({type:'conversation/semantics',version:1,mode:'accepted-exchange-v1'}))
  const input=await admit(action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'original'}},()=>true));invocation.input(input)
  const start=await admit(action.captureLifecycle!({type:'step/start',actionId:'test-action',attemptId:'test-attempt'})),startEvent=readManagedActionMembers(origin.domain,action,start.capture,start.outcome)[0]!
  const captured=await admit(action.captureToolCall!({type:'tool/call',callId:'one',name:'read_probe',args:{}})),event=readManagedActionMembers(origin.domain,action,captured.capture,captured.outcome)[0]!;if(event.type!=='tool/call')throw Error('Actual call absent')
  const accepted=await admit(action.captureModelExchange({type:'assistant/message',text:''},{type:'model/exchange-accepted',version:1,exchangeId:'one',actionId:'test-action',attemptId:'test-attempt',stepStartSeq:{kind:'prior',seq:startEvent.seq!,expectedType:'step/start'},assistantSeq:{kind:'group',position:0,expectedType:'assistant/message'},callSeqs:[{kind:'prior',seq:event.seq!,expectedType:'tool/call'}]}))
  const call={callId:event.callId,name:event.name,args:event.args,eventSeq:event.seq},batch=[call],token=invocation.accepted(accepted,[captured]);invocation.closed(token)
  expect(()=>invocation.accepted(accepted,[{...captured,capture:{...captured.capture}}])).toThrow()
  expect(()=>consumeManagedAgentModelOrigin({...binding},origin.domain,pair.registry)).toThrow()
  const foreign=execution.owner.beginAction();try{expect(()=>readManagedActionMembers(origin.domain,foreign,captured.capture,captured.outcome)).toThrow()}finally{foreign.finish()}
  let witness=captured
  if(mode==='copied-call')witness={...captured,capture:{...captured.capture}}
  const build=()=>createManagedBatchSource(origin.domain,action,invocation,token,batch,[witness],captureExecutionHookChannel(ctx),drain=>{const source=action.registerSettlementSource(drain);sources.add(source);return source})
  if(mode==='copied-call'){expect(build).toThrow();expect(effects).toBe(0);return}
  const source=build(),inspectionSource=action.registerSettlementSource(async()=>{});sources.add(inspectionSource);const toolCapture=pair.registry.capture({name:event.name,args:event.args},{sessionId:id,callId:event.callId,callEventSeq:event.seq,settlementSource:inspectionSource});expect(capturedManagedExecutionDomain(toolCapture)).toBe(origin.domain);expect(capturedManagedExecutionDomain({...toolCapture})).toBeUndefined()
  if(mode==='stop')action.stop()
  if(mode==='mutated-call')call.name='foreign'
  if(mode==='foreign-action'){const other=execution.owner.beginAction();try{expect(()=>createManagedBatchSource(origin.domain,other,invocation,token,batch,[captured],captureExecutionHookChannel(ctx),drain=>other.registerSettlementSource(drain))).toThrow()}finally{other.finish()};expect(effects).toBe(0);return}
  const run=()=>executeToolCalls(ctx,source,pair.registry,batch,{maxParallel:2,sessionId:id,signal:action.signal})
  if(mode==='stop'||mode==='mutated-call')await expect(run()).rejects.toThrow()
  else{await run();if(mode==='twice')await expect(run()).rejects.toThrow();expect(effects).toBe(1);expect(post).toBe(mode==='falsey-body'?0:1)}
  expect(received.filter(event=>event.type==='tool/call')).toHaveLength(1)
  expect(received.filter(event=>event.type==='tool/dispatch')).toHaveLength(mode==='stop'||mode==='mutated-call'?0:1)
 }finally{for(const source of sources)await source.close();invocation.invalidate();action.finish();unsubscribe();await coordinator.close()}
},30000)

it.each(['getter','no-op','fact-getter'] as const)('original action currency refuses %s replacement before invoking it',async(mode)=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'action-currency-')),c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract),{id}=await c.create(),execution=await acquireManagedExecution(c,id),ctx=createContext(),domain=createManagedAgentModelOriginOwner(ctx,execution).domain,action=execution.owner.beginAction();let entered=0
 const target=mode==='fact-getter'?action.facts.tools:action,key=mode==='fact-getter'?'call':'assertOpen',original=Object.getOwnPropertyDescriptor(target,key)!
 try{assertManagedActionCurrent(domain,action);action.stop();Object.defineProperty(target,key,mode==='no-op'?{...original,value:()=>{entered++}}:{configurable:true,enumerable:true,get(){entered++;return()=>{}}});expect(()=>assertManagedActionCurrent(domain,action)).toThrow();expect(entered).toBe(0);Object.defineProperty(target,key,original);expect(()=>assertManagedActionCurrent(domain,action)).toThrow();expect(entered).toBe(0)}finally{Object.defineProperty(target,key,original);action.finish();await c.close()}
})
