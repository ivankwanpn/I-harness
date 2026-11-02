import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({enabled:false,allow:false,key:'',keys:[] as string[]}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const backend=original.createFactJournalBackend(...args),append=backend.appendOwnedBatch,reconcile=backend.reconcileOwnedBatch;return {...backend,async appendOwnedBatch(...input:Parameters<typeof append>){const result=await append(...input),bytes=Buffer.from(input[3].bytes).toString('utf8');if(probe.enabled&&bytes.includes('"type":"session/title"')){probe.key=input[3].key.batchId;probe.keys.push(probe.key);return {kind:'unknown' as const,key:input[3].key}}return result},async reconcileOwnedBatch(...input:Parameters<typeof reconcile>){if(input[3].key.batchId===probe.key){probe.keys.push(input[3].key.batchId);if(!probe.allow)return {kind:'unknown' as const,key:input[3].key}}return reconcile(...input)}}}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createOwnedMetadataFold} from '../src/lifecycle/owned-metadata-fold.ts'
import {createSessionService} from '../src/service.ts'

it('retains unresolved title cleanup debt before admitting another private turn',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'service-title-debt-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('done'))},async r=>{r.end(wire('title'))}])
 const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],ownedTitle:{enabled:true}},model,contextWindow:4096,maxOutputTokens:128})
 probe.enabled=true;probe.allow=false;probe.key='';probe.keys=[]
 try{await expect(service.submit('main','Build a queue',new AbortController().signal)).rejects.toThrow();await expect(service.submit('main','again',new AbortController().signal)).rejects.toThrow(/cleanup incomplete|reconciliation/);expect(()=>service.rebindModel('main',{model,providerId:'fixture',modelId:'fixture',label:'fixture'})).toThrow();expect(server.requests).toHaveLength(2);await expect(service.closeSession('main')).rejects.toThrow();probe.allow=true;await service.closeSession('main');expect(new Set(probe.keys).size).toBe(1);expect((await backend.read('main')).events.filter(event=>event.type==='session/title')).toHaveLength(1)}finally{probe.enabled=false;probe.allow=true;await service.close();await coordinator.close();await server.close()}
},60000)
