Error.stackTraceLimit=60
import {join} from 'node:path'
import {setImmediate} from 'node:timers/promises'
import {createJsonlBackend} from '../../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../src/task/storage-contract.ts'
import {createLoopbackProvider} from '../../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../../llm-openai-compatible/src/index.ts'
import {createContextOutputService} from '../../../context-output/src/index.ts'
import {registerExec} from '@i-harness/exec'
import {createSessionService} from '../../../session-executor/src/service.ts'
import {createUnmanagedTaskChildHost} from '../../../session-executor/src/lifecycle/task-child-host.ts'
import {createGenerationLifecycle} from '../../../session-executor/src/lifecycle/generation-actions.ts'
import {createTaskResultRetention} from '../../../session-executor/src/lifecycle/task-result-retention.ts'
import {SHIPPING_REPORT_POLICY} from '../../src/report-policy.ts'
const root=process.argv[2];if(!root)throw Error('Original root required')
const mode=process.argv[3]
const graceful=process.argv[4]==='graceful',terminal=Promise.withResolvers<void>(),delivery=Promise.withResolvers<void>(),receiptAck=Promise.withResolvers<void>()
let childBodies=0,auxFailures=0
const backend=createJsonlBackend(join(root,'sessions'),{wrap(backend){
 const put=backend.putDocument
 backend.putDocument=async(...args)=>{
  const value=args[1] as {jobs?:unknown[]}
  if(args[0]==='parent'&&value.jobs?.length&&mode?.startsWith('aux-')){
   if(mode==='aux-after')await put(...args)
   auxFailures++;throw Error(mode)
  }
  return put(...args)
 }
},wrapOwnedBatch(append){return async(...input)=>{
 const end=Buffer.from(input[3].bytes).toString('utf8').includes('"type":"subagent/end"')
 if(end&&!graceful){
  // Required native Task result/outbox have already acknowledged. The derived
  // parent end has not issued; no cleanup or observer can fill this crash gap.
  await new Promise<never>(()=>process.stdout.write(JSON.stringify({childBodies,auxFailures})+'\n',()=>process.exit(0)))
 }
 const result=await append(...input)
 if(end&&result.kind==='committed')terminal.resolve()
 if(result.kind==='committed'&&Buffer.from(input[3].bytes).toString('utf8').includes('"type":"agent/delivery-received"')&&Buffer.from(input[3].bytes).toString('utf8').includes('"kind":"subagent"')){
  delivery.resolve()
  if(graceful)await receiptAck.promise
 }
 return result
}}})
const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
await coordinator.create({sessionId:'parent'})
const wire=(delta:unknown,finish_reason='stop')=>`data: ${JSON.stringify({choices:[{delta,finish_reason}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
const childServer=await createLoopbackProvider('/v1/chat/completions',[async response=>{
 childBodies++
 response.end(wire({content:'canonical original child result'}))
}])
const child=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:childServer.baseUrl})
const parentServer=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire({tool_calls:[{index:0,id:'original-task-call',function:{name:'spawn_agent',arguments:JSON.stringify({message:'do work',task_name:'child',background:true})}}]},'tool_calls'))},async response=>{response.end(wire({content:'parent continued'}))},async response=>{response.end(wire({content:'received child result'}))}])
const output=createContextOutputService({root:join(root,'output'),workspaceId:'canonical-crash'})
const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],ownedTask:{async options(original){
 const exec=registerExec(original.ctx);original.retain(()=>exec.dispose());original.retain(()=>output.close())
 return{parentModel:child,exec,resolveModel:async()=>({status:'unconfigured' as const,reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),generationFactoryFor:(owner,id,selected)=>(action,deps)=>createGenerationLifecycle(owner.view,id,action,{enabled:false,selectedClient:selected},deps),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(output,undefined,'parent'),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}}
}}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'parent',baseUrl:parentServer.baseUrl}),contextWindow:32000,maxOutputTokens:128})
const turn=service.submit('parent','delegate',new AbortController().signal)
// Closing an actual running parent may reject its caller; observe that flight
// independently instead of waiting for it before releasing the held receipt.
const turnSettled=turn.then(()=>{},()=>{})
if(graceful){
 await terminal.promise;await delivery.promise
 let finished=false
 const closing=service.close()
 void closing.then(()=>{finished=true},()=>{finished=true})
 await setImmediate()
 if(finished)throw Error('Close skipped the original held receipt acknowledgment')
 receiptAck.resolve()
 await closing;await turnSettled;await coordinator.close();await parentServer.close();await childServer.close();await output.close()
 console.log(JSON.stringify({childBodies,auxFailures,closed:true,waitedForReceipt:true}))
}else{await turn;await new Promise(()=>{})}
