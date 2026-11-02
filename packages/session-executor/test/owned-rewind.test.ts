import {expect,it} from 'vitest'
import {mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createFsTools} from '@i-harness/fs'
import {RewindService} from '@i-harness/rewind'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createSessionService} from '../src/service.ts'
import {mountOwnedRewind,type OwnedRewindHandle} from '../src/owned-rewind.ts'
import {withManagedRewindFacts} from '../src/lifecycle/rewind-facts.ts'
import type {ManagedRegistryConstruction} from '../src/managed-assembly.ts'

it('records a real managed FS preimage and restores it with the original rewind marker',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-rewind-'))
 await writeFile(join(root,'greet.txt'),'before')
 const backend=createJsonlBackend(join(root,'sessions')),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(delta:unknown,finish_reason:string)=>`data: ${JSON.stringify({choices:[{delta,finish_reason}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire({tool_calls:[{index:0,id:'write-call',function:{name:'rewind_write',arguments:JSON.stringify({path:'greet.txt',text:'after'})}}]},'tool_calls'))},async r=>{r.end(wire({content:'done'},'stop'))}])
 let handle:OwnedRewindHandle|undefined,original:ManagedRegistryConstruction|undefined
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],async mountRegistry(owner){original=owner;handle=await mountOwnedRewind({domain:owner.domain,root:join(root,'rewind'),workspace:root,assertCurrent:()=>owner.assertCurrent(),retain:close=>owner.retain(close)});if(!handle)throw Error('Rewind unavailable');const write=createFsTools({workspace:root,rewind:{take:handle.recorder.take.bind(handle.recorder)}}).find(tool=>tool.name==='write')!;owner.tools.register({...write,name:'rewind_write'})}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','rewrite it',new AbortController().signal)
  if(!handle||!original)throw Error('Original Rewind owner missing')
  await handle.drain();expect(await readFile(join(root,'greet.txt'),'utf8')).toBe('after')
  const points=await handle.store.readPoints();expect(points).toHaveLength(1);expect(points[0]).toMatchObject({promptPreview:'rewrite it',files:[{path:'greet.txt',status:'modified'}]})
  const engine=new RewindService({store:handle.store,workspace:root});expect((await engine.plan(0,'all')).ops).toMatchObject([{path:'greet.txt',kind:'restore-blob'}])
  await withManagedRewindFacts(original.execution,original.domain,appendEvent=>engine.execute(0,'all',{appendEvent}))
  expect(await readFile(join(root,'greet.txt'),'utf8')).toBe('before')
  expect((await backend.read('main')).events.filter(event=>event.type==='rewind/point')).toHaveLength(1)
 }finally{await service.close();await coordinator.close();await server.close()}
},180000)

it('retains the original pending sidecar when point append fails on shutdown',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-rewind-'))
 await writeFile(join(root,'greet.txt'),'before')
 const backend=createJsonlBackend(join(root,'sessions')),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(delta:unknown,finish_reason:string)=>`data: ${JSON.stringify({choices:[{delta,finish_reason}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire({tool_calls:[{index:0,id:'write-call',function:{name:'rewind_write',arguments:JSON.stringify({path:'greet.txt',text:'after'})}}]},'tool_calls'))},async r=>{r.end(wire({content:'done'},'stop'))}])
 let handle:OwnedRewindHandle|undefined,original:ManagedRegistryConstruction|undefined
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],async mountRegistry(owner){original=owner;handle=await mountOwnedRewind({domain:owner.domain,root:join(root,'rewind'),workspace:root,assertCurrent:()=>owner.assertCurrent(),retain:close=>owner.retain(close)});if(!handle)throw Error('Rewind unavailable');handle.store.appendPoint=async()=>{throw Error('controlled append failure')};const write=createFsTools({workspace:root,rewind:{take:handle.recorder.take.bind(handle.recorder)}}).find(tool=>tool.name==='write')!;owner.tools.register({...write,name:'rewind_write'})}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','rewrite it',new AbortController().signal)
  if(!handle||!original)throw Error('Original Rewind owner missing')
  await handle.drain();expect(await readFile(join(root,'greet.txt'),'utf8')).toBe('after')
  expect(await handle.store.readPoints()).toHaveLength(0)
  await handle.close();const recovered=await handle.store.recoverPending();expect(recovered).toMatchObject({promptPreview:'rewrite it',entries:[{path:'greet.txt'}]}) }finally{await service.close();await coordinator.close();await server.close()}
},180000)
