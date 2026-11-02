import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createSdkServer} from '../../sdk/src/server.ts'

it('SDK first-party observer allows original private runtime and publishes its events',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'sdk-dual-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:4096,maxOutputTokens:128}),sent:any[]=[],sdk=createSdkServer(service,{onWrite:value=>sent.push(value)})
 let published=false;const off=service.onManagedRuntimeLifecycle!(event=>{if(event.kind==='published')published=true})
 try{await service.submit('main','hello',new AbortController().signal);await new Promise(resolve=>setTimeout(resolve,0));expect(published).toBe(true);expect(sent.some(value=>value.method==='session/event'&&value.params.event.type==='turn/end')).toBe(true);await sdk.close();await service.close()}finally{off();await sdk.close();await service.close();await coordinator.close()}
},30000)
