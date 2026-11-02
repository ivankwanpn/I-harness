import {expect,it} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService,type SessionServiceOptions} from '../../session-executor/src/service.ts'
import {enrollFirstPartySelection} from '../../session-executor/src/first-party-selection.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {classifyOwnedGatewayHooks} from '../src/owned-gateway-hook-selection.ts'

it('classifies original hook inputs before either managed acquisition or complete fallback',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-select-')),hook=join(root,'hooks.json');await writeFile(hook,JSON.stringify({version:1,handlers:[]}))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'managed'});await coordinator.create({sessionId:'physical'})
 let completeCalls=0;const model=controlledModel(async function*(){yield {type:'end'}}),options:SessionServiceOptions={workspace:root,coordinator,sessionFor:async()=>{completeCalls++;throw Error('original complete hook route')},managedRuntime:{systemPrompt:'system',tools:[]},model,contextWindow:32000,maxOutputTokens:128}
 enrollFirstPartySelection(Object.freeze({options,prepare:id=>classifyOwnedGatewayHooks({configDir:root,hookConfigs:id==='physical'?[join(root,'plugins','x','hooks','hooks.json')]:[hook],assertInputsCurrent(){}})}))
 const service=createSessionService(options);let managed=false;const off=service.onManagedRuntimeLifecycle!(event=>{if(event.kind==='published'&&event.sessionId==='managed')managed=true})
 try{await service.submit('managed','hello',new AbortController().signal);expect(managed).toBe(true);await expect(service.submit('physical','hello',new AbortController().signal)).rejects.toThrow('original complete hook route');expect(completeCalls).toBe(1)}finally{off();await service.close();await coordinator.close()}
},30000)
