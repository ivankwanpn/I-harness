import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { committedFactSeqs,renderConversation } from '@i-harness/core-session'
import { createManagedExecutionDomain,readManagedAcknowledgedMembers,retainAcknowledgedExecutionMembers } from '@i-harness/core-session/internal/execution'
import { captureRestoredContextSnapshot } from '../../context-engine/src/snapshot/build.ts'
import { projectionFingerprint } from '@i-harness/token-meter'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { prepareModelRequest,type ExecutionReceipt } from '@i-harness/llm-seam'
import { createExecutionOwner } from '../../core-agent/src/agent/execution.ts'
import type { ManagedSuccessfulInstructionHandoff } from '@i-harness/core-agent'
import type { RequestEvidence } from '../../core-agent/src/agent/request-snapshot.ts'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createExecutorExecutionCache } from '../src/durable-session.ts'
import { createExecutionGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { createRuntimeContextSource } from '../src/lifecycle/action-facts.ts'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts'
const resources:(()=>Promise<void>)[]=[]
function defer(close:()=>Promise<void>){let closed=false;const release=async()=>{if(!closed){await close();closed=true}};resources.push(release);return release}
afterEach(async()=>{vi.unstubAllGlobals();const failed:unknown[]=[];for(const close of resources.splice(0).reverse())try{await close()}catch(cause){failed.push(cause)};if(failed.length)throw new AggregateError(failed,'Managed instruction fixture cleanup incomplete')})
async function fixture(){
 const cwd=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-instruction-'));await writeFile(join(cwd,'AGENTS.md'),'original rules')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(cwd,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract);defer(()=>coordinator.close());await coordinator.create({sessionId:'owner'})
 const cache=createExecutorExecutionCache({coordinator}),{execution,inputs}=await cache.get('owner'),ctx=createContext(),domain=createManagedExecutionDomain(execution.identity,execution.owner,ctx),environment=createProjectInstructionEnvironment(),runtime=createRuntimeContextSource(execution.owner)
 const manager=createMainInstructionManager({domain,environment,cwd,authority:()=>({kind:'unbound',revision:'actual',workspaceRoot:cwd}),available:()=>true,async publish(_signal,retain){const pin=retain(),source=runtime();try{committedFactSeqs(await source.captureRuntimeContext({type:'runtime/context',version:1,sections:[{name:'instructions',text:manager.text()}]},()=>{domain.assertCurrent();return true}).admit())}finally{source.finish();await pin.release()}}})
 defer(()=>cache.closeAll());defer(()=>environment.close());defer(()=>manager.close())
 await manager.reconcile();const evidence=manager.capture()!,inputSeq=await inputs.inbox.admit({inputId:'human',text:'read original',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}),action=execution.owner.beginAction(),lifecycle=createExecutionGenerationLifecycle(execution,'owner',action),generation=await lifecycle.open('main',{kind:'input',seq:inputSeq})
 committedFactSeqs(await action.facts.agent.lifecycle({type:'conversation/semantics',version:1,mode:'accepted-exchange-v1'}))
 const finish=defer(async()=>{await generation.close('stopped');await lifecycle.drain();action.finish()})
 committedFactSeqs(await action.facts.inputs.start({type:'agent/input/promoted',version:1,inputId:'human'},{type:'user/message',text:'read original',input:{inputId:'human',intent:'user'}}))
 const [stepSeq]=committedFactSeqs(await action.facts.agent.lifecycle({type:'step/start',actionId:generation.actionId,attemptId:'logical'})),request=await execution.prepareRequest(action),surface={systemPrompt:manager.text(),tools:[{name:'read',description:'read',inputSchema:{type:'object'}}]},captured=captureRestoredContextSnapshot(request.archive,{ownerSessionId:'owner',surface})
 if(captured.kind!=='captured')throw Error('Original request capture refused')
 defer(()=>request.settle())
 const model=createOpenAICompatibleClient({apiKey:'controlled',model:'fixture',baseUrl:'https://controlled.invalid'});let sends=0
 vi.stubGlobal('fetch',async()=>{sends++;return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"original-call","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const candidate:RequestEvidence={snapshot:captured.snapshot,model,instructions:evidence,projectionRevision:execution.observe().projectionRevision,neutralFingerprint:projectionFingerprint(renderConversation(captured.snapshot.conversation))},prepared=await prepareModelRequest(model,{...surface,messages:renderConversation(captured.snapshot.conversation)})
 await generation.bind(prepared)
 const transport=createExecutionOwner().candidate(prepared,candidate,{epochRebuilds:0,hasStartedSend:false,hasObservedOutput:false},false,()=>{domain.assertCurrent();return manager.current(evidence)},()=>{})
 let receipt:ExecutionReceipt|undefined,call: {id?:string;name:string;args:unknown}|undefined
 for await(const event of prepared.stream({generation:generation.control('main'),confirmExecution:confirmation=>{receipt=transport.confirm(confirmation)}}))if(event.type==='tool_call')call=event.call
 if(!receipt||!call||!action.captureToolCall)throw Error('Original physical call missing')
 const callCapture=action.captureToolCall({type:'tool/call',callId:call.id!,name:call.name,args:call.args}),callOutcome=await callCapture.admit();if(callOutcome.kind!=='committed')throw Error('Call not acknowledged')
 const callEvent=readManagedAcknowledgedMembers(domain,callCapture,callOutcome)[0]!;if(callEvent.type!=='tool/call')throw Error('Wrong actual call')
 const acceptedCapture=action.captureModelExchange({type:'assistant/message',text:''},{type:'model/exchange-accepted',version:1,exchangeId:'original-exchange',actionId:generation.actionId,attemptId:'logical',stepStartSeq:{kind:'prior',seq:stepSeq!,expectedType:'step/start'},assistantSeq:{kind:'group',position:0,expectedType:'assistant/message'},callSeqs:[{kind:'prior',seq:callEvent.seq!,expectedType:'tool/call'}]},generation.acceptance(receipt)),outcome=await acceptedCapture.admit()
 if(outcome.kind!=='committed')throw Error('Acceptance not acknowledged: '+JSON.stringify(outcome))
 const accepted=readManagedAcknowledgedMembers(domain,acceptedCapture,outcome).find(e=>e.type==='model/exchange-accepted')!
 const handoff:ManagedSuccessfulInstructionHandoff={domain,action,candidate,evidence,acceptedSeq:accepted.seq!,accepted:{capture:acceptedCapture,outcome},outcome,physicalExecutionReceipt:{...receipt,actionId:generation.actionId,attemptId:'logical'},calls:[{callId:callEvent.callId,eventSeq:callEvent.seq!,call:{name:callEvent.name,args:callEvent.args},capture:callCapture,outcome:callOutcome}]}
 const callerPins=[retainAcknowledgedExecutionMembers(acceptedCapture,outcome),retainAcknowledgedExecutionMembers(callCapture,callOutcome)]
 defer(async()=>{for(const pin of callerPins)pin.release()})
 await request.settle();transport.close()
 return {manager,handoff,domain,coordinator,execution,callerPins,sends:()=>sends,finish,async close(){for(const pin of callerPins)pin.release();await manager.close();await cache.closeAll();await environment.close();await coordinator.close()}}
}
it('managed handoff retains actual same-domain ACK obligations after original caller pins release',async()=>{
 const f=await fixture();let batch:ReturnType<typeof f.manager.managedSucceeded>|undefined
 try{batch=f.manager.managedSucceeded(f.handoff);for(const pin of f.callerPins)pin.release();await f.finish()
 expect(readManagedAcknowledgedMembers(f.domain,f.handoff.accepted.capture,f.handoff.outcome)).toHaveLength(3)
 expect(f.sends()).toBe(1);await batch!.release();batch=undefined
 expect(()=>readManagedAcknowledgedMembers(f.domain,f.handoff.accepted.capture,f.handoff.outcome)).toThrow()
 }finally{await batch?.release();await f.close()}
})
it('managed handoff refuses copied/foreign proof and changed physical receipt before instruction adoption',async()=>{
 const f=await fixture()
 try{
 await f.coordinator.create({sessionId:'foreign'});const foreign=await acquireManagedExecution(f.coordinator,'foreign'),action=foreign.owner.beginAction();if(!action.captureToolCall)throw Error('Original foreign capture absent')
 const capture=action.captureToolCall({type:'tool/call',callId:'original-call',name:'read',args:{}}),outcome=await capture.admit();if(outcome.kind!=='committed')throw Error('Foreign capture unacknowledged')
 expect(()=>f.manager.managedSucceeded({...f.handoff,calls:[{...f.handoff.calls[0]!,capture,outcome}]})).toThrow();action.finish();await foreign.close()
 expect(()=>f.manager.managedSucceeded({...f.handoff,domain:{...f.domain}})).toThrow()
 expect(()=>f.manager.managedSucceeded({...f.handoff,outcome:{...f.handoff.outcome}})).toThrow()
 expect(()=>f.manager.managedSucceeded({...f.handoff,accepted:{...f.handoff.accepted,capture:{...f.handoff.accepted.capture}}})).toThrow()
 expect(()=>f.manager.managedSucceeded({...f.handoff,physicalExecutionReceipt:{...f.handoff.physicalExecutionReceipt,sendId:'different'}})).toThrow()
 expect(()=>f.manager.managedSucceeded({...f.handoff,calls:[{...f.handoff.calls[0]!,call:{name:'read',args:{changed:true}}}]})).toThrow()
 let callbacks=0;const hostile=Object.defineProperty({...f.handoff},'accepted',{get(){callbacks++;throw Error('hostile')}})
 expect(()=>f.manager.managedSucceeded(hostile)).toThrow();expect(callbacks).toBe(0);await f.finish()
 }finally{await f.close()}
})
