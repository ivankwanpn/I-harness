import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({issued:[] as unknown[],reconciled:[] as unknown[]}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{
 const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
 return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){
  const backend=original.createFactJournalBackend(...args)
  return {...backend,async appendOwnedBatch(...input:Parameters<typeof backend.appendOwnedBatch>){
   const frame=JSON.parse(Buffer.from(input[3].bytes).toString('utf8'))
   const result=await backend.appendOwnedBatch(...input)
   if(frame.events.some((event:{type:string;op?:string})=>event.type==='agent/input/preparation'&&event.op==='completed')){probe.issued.push(input[3].key);return {kind:'unknown' as const,key:input[3].key}}
   return result
  },async reconcileOwnedBatch(...input:Parameters<typeof backend.reconcileOwnedBatch>){probe.reconciled.push(input[3].key);return backend.reconcileOwnedBatch(...input)}}
 }}
})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createSessionService} from '../src/service.ts'

it('reconciles an unknown original preparation completion without replaying the host transform',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-unknown-prepare-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 let transforms=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],prepareInput:async text=>{transforms++;return text+' prepared'}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','raw',new AbortController().signal)
  expect(transforms).toBe(1);expect(probe.issued).toHaveLength(1);expect(probe.reconciled).toContainEqual(probe.issued[0]);expect(server.requests).toHaveLength(1)
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)
