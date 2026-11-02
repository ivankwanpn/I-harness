import {expect,it,vi} from 'vitest'
const watch=vi.hoisted(()=>({changed:undefined as undefined|(()=>void)}))
vi.mock('../src/context/instructions/index.ts',async load=>{
 const original=await load<typeof import('../src/context/instructions/index.ts')>()
 return {...original,createProjectInstructionEnvironment(){
  const environment=original.createProjectInstructionEnvironment(),host=environment.host
  return {...environment,host:{...host,create(scope:Parameters<typeof host.create>[0]){
   const service=host.create(scope)
   service.subscribe(()=>watch.changed?.())
   return service
  }}}
 }}
})
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createSessionService} from '../src/service.ts'

it('a watched instruction change reaches the next original physical turn',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-instruction-watch-')),path=join(root,'AGENTS.md')
 await writeFile(path,'FIRST_WATCH_RULE')
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const respond=async(response:import('node:http').ServerResponse)=>{response.end(wire)}
 const server=await createLoopbackProvider('/v1/chat/completions',[respond,respond])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','first',new AbortController().signal)
  const changed=Promise.withResolvers<void>();watch.changed=changed.resolve
  await writeFile(path,'SECOND_WATCH_RULE');await changed.promise;watch.changed=undefined
  await service.submit('main','second',new AbortController().signal)
  expect(JSON.stringify(server.requests[0]!.body)).toContain('FIRST_WATCH_RULE')
  expect(JSON.stringify(server.requests[1]!.body)).toContain('SECOND_WATCH_RULE')
  expect(JSON.stringify(server.requests[1]!.body)).not.toContain('FIRST_WATCH_RULE')
  await service.closeSession('main')
  const events=(await backend.read('main')).events.filter(event=>event.type==='runtime/context')
  expect(JSON.stringify(events)).toContain('FIRST_WATCH_RULE');expect(JSON.stringify(events)).toContain('SECOND_WATCH_RULE')
 }finally{watch.changed=undefined;await service.close();await coordinator.close();await server.close()}
},30000)
