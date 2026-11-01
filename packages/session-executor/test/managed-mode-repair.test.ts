import {expect,it,vi} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import * as privateExecution from '../../session-persistence/src/execution-internal.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createSessionService,type SessionServiceOptions} from '../src/service.ts'
const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'mode-repair-'));const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);return {root,coordinator}}

it('repair routes configured prompt/tool/compaction/policy families to complete before private input/model effects',async()=>{
 const {root,coordinator}=await fixture()
 const cases:Partial<SessionServiceOptions>[]=[{compact:{auto:false}},{autoCompactionEnabled:()=>false},{preset:'{}'},{planMode:false},{additionalTools:[]},{instructionSettingsPath:join(root,'instructions.json')},{shellTimeoutMs:2000},{approvalMode:'full-access'},{rewindStoreRoot:join(root,'rewind')}]
 try{for(const [index,configured]of cases.entries()){
  const id=`mode-${index}`;await coordinator.create({sessionId:id});let models=0
  const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[]},...configured,modelBuilder:async()=>{models++;throw Error('Private model must not resolve')}})
  const refusal=Error('Original complete route'),opened=vi.spyOn(coordinator,'openManagedDocument').mockRejectedValue(refusal)
  try{await expect(service.submit(id,'raw',new AbortController().signal)).rejects.toBe(refusal);expect(opened).toHaveBeenCalled();expect(models).toBe(0)}finally{await service.close();opened.mockRestore()}
 }}finally{await coordinator.close()}
},30000)

it.each(['resolved','undefined','atomic'] as const)('repair keeps original scalar resolver precedence on actual wire: %s',async mode=>{
 const {root,coordinator}=await fixture();await coordinator.create({sessionId:'main'})
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const client=createOpenAICompatibleClient({apiKey:'loopback',model:'o3-mini',baseUrl:server.baseUrl})
 const window=vi.fn(()=>mode==='undefined'?undefined:4096),effort=vi.fn(()=>mode==='undefined'?undefined:'low' as const)
 const metadata=(await coordinator.profile('main')).meta
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[]},contextWindow:1,reasoningEffort:'high',maxOutputTokens:128,loadMeta:async()=>metadata,contextWindowFor:window,reasoningEffortFor:effort,
  ...(mode==='atomic'?{modelBindingFor:async()=>({status:'ready' as const,binding:{model:client,providerId:'loopback',modelId:'o3-mini',label:'owned',contextWindow:4096,reasoningEffort:'medium' as const,maxOutputTokens:128}})}:{modelBuilder:async()=>client})})
 try{await service.submit('main','raw',new AbortController().signal);expect(server.requests).toHaveLength(1);expect(server.requests[0]!.body.reasoning_effort).toBe(mode==='atomic'?'medium':mode==='undefined'?undefined:'low');if(mode==='atomic'){expect(window).not.toHaveBeenCalled();expect(effort).not.toHaveBeenCalled()}else{expect(window).toHaveBeenCalledWith('main',metadata);expect(effort).toHaveBeenCalledWith('main',metadata)}}
 finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('repair keeps public-first selection during held complete construction and subsequent admission/submit',async()=>{
 const {root,coordinator}=await fixture();await coordinator.create({sessionId:'main'})
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[]},modelBuilder:async()=>{entered.resolve();await release.promise;return createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})},contextWindow:32000,maxOutputTokens:128})
 const acquire=vi.spyOn(privateExecution,'acquireManagedExecution')
 const build=service.assemblyFor('main')
 try{await entered.promise;const inbox=await service.receivedInputFor('main');await inbox.admit({inputId:'public',text:'raw',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}});release.resolve();const assembly=await build;expect(service.liveSession('main')).toBe(assembly.session);await service.submit('main','raw',new AbortController().signal,{admittedInputId:'public'});expect(acquire).not.toHaveBeenCalled();expect(server.requests).toHaveLength(1);await service.closeSession('main');const next=await service.receivedInputFor('main');expect(next.pending()).toEqual([]);expect(acquire).toHaveBeenCalledTimes(1)}
 finally{release.resolve();await build.catch(()=>{});await service.close();acquire.mockRestore();await coordinator.close();await server.close()}
},30000)
