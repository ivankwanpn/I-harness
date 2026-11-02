import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createOwnedMetadataFold} from '../src/lifecycle/owned-metadata-fold.ts'
import {createSessionService} from '../src/service.ts'
import {completeCheckpoint} from '../../compaction/test/fixtures/checkpoint.ts'

it('runs original owned title within the actual private service submission',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'service-title-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('done'))},async r=>{r.end(wire('Queue title'))}])
 const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],ownedTitle:{enabled:true,titleMaxOutputTokens:32}},model,contextWindow:4096,maxOutputTokens:128})
 try{await service.submit('main','Build a queue',new AbortController().signal);expect(server.requests).toHaveLength(2);expect(server.requests[1]!.body).toMatchObject({max_tokens:32});const events=(await backend.read('main')).events;expect(events).toContainEqual(expect.objectContaining({type:'session/title',title:'Queue title',source:'provider'}));expect(service.liveSession('main')).toBeUndefined()}finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('rebinds the published private runtime before the next physical service request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'service-rebind-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`
 const first=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('first'))}]),second=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('second'))}])
 const model=createOpenAICompatibleClient({apiKey:'loopback',model:'first',baseUrl:first.baseUrl}),replacement=createOpenAICompatibleClient({apiKey:'loopback',model:'second',baseUrl:second.baseUrl})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:4096,maxOutputTokens:128})
 try{await service.submit('main','first',new AbortController().signal);expect(service.rebindModel('main',{model:replacement,providerId:'fixture',modelId:'second',label:'fixture:second',contextWindow:4096,maxOutputTokens:64})).toBe(true);await service.submit('main','second',new AbortController().signal);expect(first.requests).toHaveLength(1);expect(second.requests).toHaveLength(1);expect(second.requests[0]!.body).toMatchObject({model:'second',max_tokens:64})}finally{await service.close();await coordinator.close();await first.close();await second.close()}
},30000)

it('keeps the service task current during held title and Stop denies publication',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'service-title-stop-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`,entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('done'))},async r=>{entered.resolve();await release.promise;r.end(wire('late title'))}])
 const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],ownedTitle:{enabled:true}},model,contextWindow:4096,maxOutputTokens:128})
 const turn=service.submit('main','Build a queue',new AbortController().signal),observed=turn.catch(error=>error)
 try{await entered.promise;expect(service.queueState('main').running).toBe(true);expect(()=>service.rebindModel('main',{model,providerId:'fixture',modelId:'fixture',label:'fixture'})).toThrow(/busy/);expect(service.cancelRunning!('main').cancelled).toBe(true);release.resolve();await observed;expect((await backend.read('main')).events.filter(event=>event.type==='session/title')).toHaveLength(0)}finally{release.resolve();await observed;await service.close();await coordinator.close();await server.close()}
},30000)

it('runs manual compaction through the original private service owner',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'service-compact-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('first'))},async r=>{r.end(wire('second'))},async r=>{r.end(wire(completeCheckpoint()))}])
 const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],compact:{auto:false,minSummaryChars:1}},model,contextWindow:100000,maxOutputTokens:1000})
 try{await service.submit('main','original work '.repeat(300),new AbortController().signal);await service.submit('main','continue',new AbortController().signal);const result=await service.compact('main');expect(result).toMatchObject({compacted:true,publication:'committed'});expect(server.requests).toHaveLength(3);expect((await backend.read('main')).events.some(event=>event.type==='compaction/replacement')).toBe(true);expect(service.liveSession('main')).toBeUndefined()}finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('uses the rebound original model and limits for the later title request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'service-title-rebind-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const first=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('initial'))}]),second=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('response'))},async r=>{r.end(wire('Rebound title'))}])
 const model=createOpenAICompatibleClient({apiKey:'loopback',model:'first',baseUrl:first.baseUrl}),replacement=createOpenAICompatibleClient({apiKey:'loopback',model:'second',baseUrl:second.baseUrl})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],ownedTitle:{enabled:true,titleMaxOutputTokens:64}},model,contextWindow:4096,maxOutputTokens:128})
 try{
  const input=await service.managedInputFor!('main');if(!input)throw Error('Original input owner absent')
  await input.inbox.admit({inputId:'synthetic',text:'system source',delivery:'queue',intent:'system',provenance:{kind:'plugin',authority:'observation',scope:'turn',producer:'session.notification'},synthetic:{description:'fixture',scope:'turn'}})
  await service.submit('main','system source',new AbortController().signal,{admittedInputId:'synthetic'});expect(first.requests).toHaveLength(1)
  expect(service.rebindModel('main',{model:replacement,providerId:'fixture',modelId:'second',label:'fixture:second',contextWindow:4096,maxOutputTokens:40})).toBe(true)
  await service.submit('main','Build an ordered queue',new AbortController().signal);expect(second.requests).toHaveLength(2);expect(second.requests[1]!.body).toMatchObject({model:'second',max_tokens:40});expect((await backend.read('main')).events).toContainEqual(expect.objectContaining({type:'session/title',title:'Rebound title'}))
 }finally{await service.close();await coordinator.close();await first.close();await second.close()}
},30000)

it('uses the rebound private model for the actual manual summary',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'service-compact-rebind-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const first=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('first'))},async r=>{r.end(wire('second'))}]),second=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire(completeCheckpoint()))}])
 const model=createOpenAICompatibleClient({apiKey:'loopback',model:'first',baseUrl:first.baseUrl}),replacement=createOpenAICompatibleClient({apiKey:'loopback',model:'second',baseUrl:second.baseUrl})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],compact:{auto:false,minSummaryChars:1}},model,contextWindow:100000,maxOutputTokens:1000})
 try{await service.submit('main','original work '.repeat(300),new AbortController().signal);await service.submit('main','continue',new AbortController().signal);expect(service.rebindModel('main',{model:replacement,providerId:'fixture',modelId:'second',label:'fixture:second',contextWindow:100000,maxOutputTokens:500})).toBe(true);const result=await service.compact('main');expect(result).toMatchObject({compacted:true,publication:'committed'});expect(second.requests).toHaveLength(1);expect(second.requests[0]!.body).toMatchObject({model:'second'});expect((await backend.read('main')).events.some(event=>event.type==='compaction/replacement')).toBe(true)}finally{await service.close();await coordinator.close();await first.close();await second.close()}
},60000)

it('uses the rebound private model for automatic compaction before the next turn',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'service-auto-rebind-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const first=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('first'))}]),second=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire(completeCheckpoint()))},async r=>{r.end(wire('continued'))}])
 const model=createOpenAICompatibleClient({apiKey:'loopback',model:'first',baseUrl:first.baseUrl}),replacement=createOpenAICompatibleClient({apiKey:'loopback',model:'second',baseUrl:second.baseUrl});let enabled=false
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],compact:{auto:true,thresholdRatio:.15,targetRatio:.1,minTurnsBeforeRecompact:0,minSummaryChars:1},autoCompactionEnabled:()=>enabled},model,contextWindow:20000,maxOutputTokens:5000})
 try{await service.submit('main','work '.repeat(1500),new AbortController().signal);expect(service.rebindModel('main',{model:replacement,providerId:'fixture',modelId:'second',label:'fixture:second',contextWindow:20000,maxOutputTokens:5000})).toBe(true);enabled=true;await service.submit('main','continue',new AbortController().signal);expect(second.requests).toHaveLength(2);expect(second.requests[0]!.body).toMatchObject({model:'second'});expect((await backend.read('main')).events.some(event=>event.type==='compaction/replacement')).toBe(true)}finally{await service.close();await coordinator.close();await first.close();await second.close()}
},60000)
