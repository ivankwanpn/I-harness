import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({enabled:false,allow:false,target:'source',key:'',keys:[] as string[],notify:()=>{}}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const backend=original.createFactJournalBackend(...args),append=backend.appendOwnedBatch,reconcile=backend.reconcileOwnedBatch;return {...backend,async appendOwnedBatch(...input:Parameters<typeof append>){const result=await append(...input),bytes=Buffer.from(input[3].bytes).toString('utf8');if(probe.enabled&&bytes.includes('"kind":"exec"')&&bytes.includes(probe.target==='source'?'"type":"agent/delivery-source"':'"type":"agent/delivery-received"')){probe.key=input[3].key.batchId;probe.keys.push(probe.key);probe.notify();return {kind:'unknown' as const,key:input[3].key}}return result},async reconcileOwnedBatch(...input:Parameters<typeof reconcile>){if(input[3].key.batchId===probe.key){probe.keys.push(input[3].key.batchId);if(!probe.allow)return {kind:'unknown' as const,key:input[3].key}}return reconcile(...input)}}}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createExecutionLease,type TransportExecutionBackend} from '@i-harness/sandbox'
import {compileExecutionPolicy} from '@i-harness/sandbox-policy'
import {createShellTools} from '@i-harness/shell'
import {createExecutionApprovalPolicy} from '@i-harness/guard-approval'
import {createContextOutputService} from '@i-harness/context-output'
import {committedFactSeqs,type CapturedActionFact,type FactOutcome} from '@i-harness/core-session'
import {readManagedActionMembers,subscribeManagedExecution} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createManagedAgentModelOriginOwner,consumeManagedAgentModelOrigin,createManagedModelInvocation} from '../../core-agent/src/tool-batch/managed-model-origin.ts'
import {createManagedBatchSource} from '../../core-agent/src/tool-batch/managed-source.ts'
import {executeToolCalls} from '../../core-agent/src/execute-tool-calls.ts'
import {createExecServiceWithReservation} from '../../exec/src/service.ts'
import {createScopedPrivateExecWithReservation} from '../src/scoped-exec.ts'
import {createExecResultRetention} from '../src/lifecycle/exec-result-retention.ts'
import {createToolResultRetention} from '../src/lifecycle/result-retention.ts'
import {receivedExecutionInputsFor} from '../src/lifecycle/execution-inputs.ts'

it.each(['healthy','denial','stop','unknown','receipt-unknown'] as const)('runs the original private Shell member through its native lease and retained source (%s)',async(mode)=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-native-shell-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),inputs=receivedExecutionInputsFor(execution),delivery=inputs.execDelivery(origin.domain)
 const output=createContextOutputService({root:join(root,'results'),workspaceId:'private-shell',config:{enabled:false}})
 let launches=0,releases=0,rollbacks=0;const completed=Promise.withResolvers<void>(),end=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),releasePrepare=Promise.withResolvers<void>(),unknown=Promise.withResolvers<void>()
 probe.enabled=mode==='unknown'||mode==='receipt-unknown';probe.target=mode==='receipt-unknown'?'receipt':'source';probe.allow=false;probe.key='';probe.keys=[];probe.notify=unknown.resolve
 const backend:TransportExecutionBackend={async probe(){return{id:'controlled',availability:'available',assurance:'unverified',features:{writeIsolation:false,readIsolation:false,denyPaths:false,pipes:true,pty:false,retainedTree:true}}},async prepare(spec,policy){if(mode==='stop'){entered.resolve();await releasePrepare.promise}return {policy,async rollback(){rollbacks++},async commit(check){check();launches++;const lease=createExecutionLease({receipt:{executionId:'actual-native',backendId:'controlled',policyFingerprint:policy.fingerprint,owner:spec.owner,assurance:'unverified'},rootExited:completed.promise.then(()=>({exitCode:0})),waitTreeEmpty:()=>completed.promise,settleIo:async()=>{},async releaseResources(){releases++},async terminate(){completed.resolve()}});return {...lease,get settled(){return lease.settled},pid:1,io:{async write(){},async endInput(){},output:(async function*(){yield {channel:'stdout' as const,data:Buffer.from('native actual output')};await completed.promise})()}}}}}}
 const native=createExecServiceWithReservation({execution:{defaultOwner:{sessionId:'parent'},selectBackend:()=>backend,resolvePolicy:owner=>compileExecutionPolicy({mode:'danger-full-access',owner,authority:{kind:'unbound',revision:'private-test',workspaceRoot:root}}),validateAuthority(){}},resultRetention:createExecResultRetention(output)})
 const scoped=createScopedPrivateExecWithReservation(native,root,()=>undefined,execution,origin.domain,ctx,delivery)
 const registry=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'},resultRetention:createToolResultRetention(output)},origin.verifier)
 for(const tool of createShellTools({exec:scoped.service,directEntry:scoped.direct,agentShell:()=>({id:'controlled',label:'controlled',command:'controlled',dialect:'posix'})}))registry.registry.register(tool)
 if(mode==='denial')createExecutionApprovalPolicy(ctx,registry.registry,{workspace:root,approvalPolicy:'never'})
 const binding=origin.bind(registry.registry,registry.driver),state=consumeManagedAgentModelOrigin(binding,origin.domain,registry.registry),action=execution.owner.beginAction(),invocation=createManagedModelInvocation(state,action),sources=new Set<ReturnType<typeof action.registerSettlementSource>>()
 const admit=async(capture:CapturedActionFact<FactOutcome>)=>{const outcome=await capture.admit();if(outcome.kind!=='committed')throw Error(`Expected original ACK: ${outcome.kind}`);return {capture,outcome}}
 const received:import('@i-harness/core-session').SessionEvent[]=[];const off=subscribeManagedExecution(origin.domain,event=>{received.push(event);if(event.type==='exec/end')end.resolve()})
 try{
  committedFactSeqs(await inputs.facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'run',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}))
  await admit(action.captureLifecycle!({type:'conversation/semantics',version:1,mode:'accepted-exchange-v1'}))
  const input=await admit(action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'run'}},()=>true));invocation.input(input)
  const start=await admit(action.captureLifecycle!({type:'step/start',actionId:'a',attemptId:'t'})),startEvent=readManagedActionMembers(origin.domain,action,start.capture,start.outcome)[0]!
  const captured=await admit(action.captureToolCall!({type:'tool/call',callId:'actual',name:'shell',args:{command:mode==='denial'?'rm -rf /':'controlled',background:true}})),event=readManagedActionMembers(origin.domain,action,captured.capture,captured.outcome)[0]!;if(event.type!=='tool/call')throw Error('Missing actual call')
  const accepted=await admit(action.captureModelExchange({type:'assistant/message',text:''},{type:'model/exchange-accepted',version:1,exchangeId:'x',actionId:'a',attemptId:'t',stepStartSeq:{kind:'prior',seq:startEvent.seq!,expectedType:'step/start'},assistantSeq:{kind:'group',position:0,expectedType:'assistant/message'},callSeqs:[{kind:'prior',seq:event.seq!,expectedType:'tool/call'}]}))
  const call={callId:event.callId,name:event.name,args:event.args,eventSeq:event.seq},calls=[call],token=invocation.accepted(accepted,[captured]);invocation.closed(token)
  const batch=createManagedBatchSource(origin.domain,action,invocation,token,calls,[captured],captureExecutionHookChannel(ctx),drain=>{const source=action.registerSettlementSource(drain);sources.add(source);return source})
  const running=executeToolCalls(ctx,batch,registry.registry,calls,{maxParallel:1,sessionId:'parent',signal:action.signal})
  if(mode==='stop'){await entered.promise;action.stop();releasePrepare.resolve();await running.catch(()=>{});await end.promise;expect(launches).toBe(0);expect(rollbacks).toBe(1);expect(received.filter(event=>event.type==='exec/end')).toHaveLength(1);return}
  if(mode==='denial'){await expect(running).rejects.toThrow(/denied.*approval policy/);expect(launches).toBe(0);expect(received.some(event=>event.type==='tool/dispatch')).toBe(false);expect(execution.observe().delivery.execPending()).toHaveLength(0);return}
  if(mode==='unknown'){await unknown.promise;expect(launches).toBe(0);probe.allow=true;await running.catch(()=>{});await end.promise;expect(probe.keys.length).toBeGreaterThan(1);expect(new Set(probe.keys).size).toBe(1);expect(received.filter(event=>event.type==='agent/delivery-source'&&event.kind==='exec')).toHaveLength(1);expect(received.filter(event=>event.type==='exec/end')).toHaveLength(1);expect(launches).toBe(0);return}
  await running
  expect(launches).toBe(1);completed.resolve();await end.promise
  const candidates=execution.observe().delivery.execPending();expect(candidates).toHaveLength(1);expect(candidates[0]!.terminal).toMatchObject({type:'exec/end',execution:{dispatch:'dispatched',outcome:'succeeded'},dependency:{retention:{kind:'artifact'}}})
  const terminal=candidates[0]!.terminal;if(!('dependency'in terminal)||terminal.dependency.retention.kind!=='artifact')throw Error('Original retained frame artifact missing')
  const ref=terminal.dependency.retention.ref
  expect(await output.readExecResult({sessionId:'parent'},{ref})).toMatchObject({frames:[{data:Buffer.from('native actual output').toString('base64')}]})
  await expect(output.readExecResult({sessionId:'foreign'},{ref})).rejects.toThrow()
  if(mode==='receipt-unknown'){
    const first=delivery.reconcileExecCandidates();void first.catch(()=>{});await unknown.promise;await expect(first).rejects.toThrow();expect(()=>execution.observe()).toThrow();probe.allow=true
    await delivery.reconcileExecCandidates();expect(probe.keys.length).toBeGreaterThan(1);expect(new Set(probe.keys).size).toBe(1)
  }else await delivery.reconcileExecCandidates()
  expect(execution.observe().delivery.execPending()).toHaveLength(0);expect(execution.observe().inbox.pending().filter(input=>input.synthetic?.description?.startsWith('Exec '))).toHaveLength(1);expect(received.filter(event=>event.type==='agent/delivery-received'&&event.key.kind==='exec')).toHaveLength(1)
 }finally{probe.allow=true;probe.enabled=false;completed.resolve();releasePrepare.resolve();off();for(const source of sources)await source.close();invocation.invalidate();action.finish();await native.service.dispose();await inputs.close();await output.close();await coordinator.close()}
 expect(releases).toBe(1)
},30000)
