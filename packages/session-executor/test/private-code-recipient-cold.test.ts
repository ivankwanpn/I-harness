import {expect,it,vi} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createSessionService,createDurableSessionLoader} from '../src/index.ts'
import {receivedExecutionInputsFor} from '../src/lifecycle/execution-inputs.ts'

it('cold private recipient finds the original committed Code receipt without a pending candidate',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'code-cold-recipient-')),sessions=join(root,'sessions')
 let coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent')
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const rounds=Array.from({length:4},(_,i)=>async(response:import('node:http').ServerResponse)=>{const delta=i===0?{tool_calls:[{index:0,id:'code-call',type:'function',function:{name:'code_exec',arguments:JSON.stringify({code:'await tools.pause({});text("actual output")',yield_time_ms:0})}}]}:{content:'done'};response.end('data: '+JSON.stringify({choices:[{delta,finish_reason:i===0?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')})
 const server=await createLoopbackProvider('/v1/chat/completions',rounds),model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
 const service=createSessionService({workspace:root,coordinator,sessionFor:createDurableSessionLoader(coordinator),model,modelPolicy:'test-mock',approveAll:true,sandbox:'danger-full-access',codeMode:{mode:'mixed'},contextWindow:100000,additionalTools:[{name:'pause',description:'hold original Worker',inputSchema:{type:'object'},async execute(){entered.resolve();await release.promise;return 'done'}}]})
 let saved:Extract<import('@i-harness/core-session').SessionEvent,{type:'agent/delivery-received'}>|undefined
 try{
  const running=service.submit('parent','run original Code',new AbortController().signal);await Promise.race([entered.promise,running.then(()=>{throw Error('Original Worker not entered')})]);await running;release.resolve()
  await vi.waitFor(()=>expect(document.view.events.filter(event=>event.type==='agent/delivery-received'&&event.key.kind==='code')).toHaveLength(1),{timeout:5000})
  const receipt=document.view.events.find(event=>event.type==='agent/delivery-received'&&event.key.kind==='code');if(!receipt||receipt.type!=='agent/delivery-received')throw Error('Original Code receipt absent');saved=receipt
 }finally{release.resolve();await service.close();await coordinator.close();await server.close()}
 coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract)
 let inputs:ReturnType<typeof receivedExecutionInputsFor>|undefined
 try{
  const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,createContext());inputs=receivedExecutionInputsFor(execution);const recipient=inputs.codeDelivery(domain),before=execution.observe().eventCount
  expect(execution.observe().delivery.codePending()).toHaveLength(0)
  const original=execution.observe().delivery.receipt(saved!.key);expect(original).toBeDefined()
  let invoked=false;const getter={kind:'code' as const,get sourceSeq(){invoked=true;return saved!.sourceSeq},terminalSeq:saved!.terminalSeq}
  await expect(recipient.admitCode(getter)).rejects.toThrow();expect(invoked).toBe(false)
  const mutable={kind:'code' as const,sourceSeq:saved!.sourceSeq,terminalSeq:saved!.terminalSeq},reading=recipient.admitCode(mutable);mutable.terminalSeq++
  const result=await reading
  expect(result).toMatchObject({inputId:saved!.inputId,disposition:original!.disposition});expect(execution.observe().eventCount).toBe(before)
  await expect(recipient.admitCode({kind:'code',sourceSeq:saved!.sourceSeq,terminalSeq:saved!.terminalSeq+1})).rejects.toThrow()
 }finally{await inputs?.close();await coordinator.close()}
},30000)
