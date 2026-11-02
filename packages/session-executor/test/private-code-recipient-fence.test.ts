import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({enabled:false,allow:false,key:'',keys:[] as string[],notify:()=>{}}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const backend=original.createFactJournalBackend(...args),append=backend.appendOwnedBatch,reconcile=backend.reconcileOwnedBatch;return {...backend,async appendOwnedBatch(...input:Parameters<typeof append>){const result=await append(...input),bytes=Buffer.from(input[3].bytes).toString('utf8');if(probe.enabled&&bytes.includes('"type":"agent/delivery-received"')&&bytes.includes('"kind":"code"')){probe.key=input[3].key.batchId;probe.keys.push(probe.key);probe.notify();return {kind:'unknown' as const,key:input[3].key}}return result},async reconcileOwnedBatch(...input:Parameters<typeof reconcile>){if(input[3].key.batchId===probe.key){probe.keys.push(input[3].key.batchId);if(!probe.allow)return {kind:'unknown' as const,key:input[3].key}}return reconcile(...input)}}}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {subscribe} from '@i-harness/core-session'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createAgent} from '../../core-agent/src/index.ts'
import {createAgentModelOriginOwner} from '../../core-agent/src/tool-batch/model-origin.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {registerCodeMode} from '../../code-mode/src/register.ts'
import {createContextOutputService} from '../../context-output/src/index.ts'
import {createCodeTextRetention} from '../src/lifecycle/code-text-retention.ts'
import {createCodeFinalOutputRetention} from '../src/lifecycle/code-final-output-retention.ts'
import {createGenerationLifecycle} from '../src/lifecycle/generation-actions.ts'
import {receivedInputsFor} from '../src/lifecycle/received-inputs.ts'
import {receivedExecutionInputsFor} from '../src/lifecycle/execution-inputs.ts'

it.each(['healthy','receipt-unknown'] as const)('retains the original Code receipt after private Stop without reopening admission (%s)',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'code-fence-recipient-')),sessions=join(root,'sessions')
 let coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ctx=createContext(),origin=createAgentModelOriginOwner({view:document.view,factOwner:document}),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{view:document.view,factOwner:document,context:ctx,sessionId:'parent'}},origin.verifier),ended=Promise.withResolvers<void>()
 const output=createContextOutputService({root:join(root,'results'),workspaceId:'private-code-fence'})
 const mount=registerCodeMode(ctx,pair.registry,{session:document.view,sessionId:'parent',factOwner:document,config:{mode:'mixed'},retainText:createCodeTextRetention({service:output,sessionId:'parent',sourceFor:async()=>({sourceId:'original-code-output'})}),finalOutput:createCodeFinalOutputRetention({service:output,sourceFor:async()=>({sourceId:'original-code-output'})})})
 const rounds=[async(response:import('node:http').ServerResponse)=>{response.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'code-call',type:'function',function:{name:'code_exec',arguments:JSON.stringify({code:'text("actual original output")',yield_time_ms:0})}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')},async(response:import('node:http').ServerResponse)=>{response.end('data: '+JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')}]
 const server=await createLoopbackProvider('/v1/chat/completions',rounds),agent=createAgent(ctx,{session:document.view,sessionId:'parent',factOwner:document,tools:pair.registry,modelCallOrigin:origin.bind(pair.registry,pair.driver),model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'test',generationFactory:(action,deps)=>createGenerationLifecycle(document.view,'parent',action,undefined,deps)}),off=subscribe(document.view,event=>{if(event.type==='code/end')ended.resolve()})
 let evidence:{kind:'code';sourceSeq:number;terminalSeq:number}|undefined
 try{
  await receivedInputsFor(document,'parent').inbox.admit({inputId:'human',text:'run',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
  await agent.run('run',undefined,undefined,'human');await ended.promise
  const source=document.view.events.find(event=>event.type==='agent/delivery-source'&&event.kind==='code'),terminal=document.view.events.find(event=>event.type==='code/end')
  if(!source||source.type!=='agent/delivery-source'||source.kind!=='code'||!terminal||terminal.type!=='code/end')throw Error('Original Code source or terminal missing')
  evidence={kind:'code',sourceSeq:source.seq!,terminalSeq:terminal.seq!}
 }finally{off();await mount.dispose();await coordinator.close();await output.close();await server.close()}
 coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract);let inputs:ReturnType<typeof receivedExecutionInputsFor>|undefined
 try{
  const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,createContext());inputs=receivedExecutionInputsFor(execution);const recipient=inputs.codeDelivery(domain)
  expect(execution.observe().delivery.codePending()).toHaveLength(1)
  const unknown=Promise.withResolvers<void>();probe.enabled=mode==='receipt-unknown';probe.allow=false;probe.key='';probe.keys=[];probe.notify=unknown.resolve
  if(mode==='receipt-unknown'){const first=recipient.admitCode(evidence!);void first.catch(()=>{});await unknown.promise;await expect(first).rejects.toThrow();expect(()=>execution.observe()).toThrow();probe.allow=true}
  const receipt=await recipient.admitCode(evidence!);expect(receipt.disposition).toBe('pending');expect(await recipient.admitCode(evidence!)).toEqual(receipt);expect(inputs.inbox.pending().filter(input=>input.inputId===receipt.inputId)).toHaveLength(1)
  if(mode==='receipt-unknown'){expect(probe.keys.length).toBeGreaterThan(1);expect(new Set(probe.keys).size).toBe(1)}
  const close=recipient.requestClose('user-stop');await close.settled;execution.revokeNewWork()
  expect(await recipient.admitCode(evidence!)).toMatchObject({inputId:receipt.inputId,disposition:'suppressed'})
 }finally{probe.enabled=false;probe.allow=true;await inputs?.close();await coordinator.close()}
},30000)
