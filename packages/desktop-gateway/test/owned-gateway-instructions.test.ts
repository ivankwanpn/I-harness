import {expect,it} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createInstructionEnvironment} from '../../session-executor/src/context/instructions/index.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createOwnedGatewayInstructions} from '../src/owned-gateway-instructions.ts'

it('shares configured host instruction environment and revokes runtime binding on close',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-instructions-'));await writeFile(join(root,'AGENTS.md'),'Original instruction fixture')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const environment=createInstructionEnvironment({settingsPath:join(root,'settings.json')}),authority=()=>({kind:'unbound' as const,revision:'workspace',workspaceRoot:root})
 const acquire=createOwnedGatewayInstructions({workspace:root,environment,authorityFor:async()=>authority})
 let requestText='';const model=controlledModel(async function*(request){requestText=JSON.stringify(request);yield {type:'text/chunk',text:'done'};yield {type:'end'}});let binding:(()=>boolean)|undefined,seen=false
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],acquireInstructions:acquire,mountRegistry(original){expect(original.instructions?.environment).toBe(environment);binding=original.instructions!.available;seen=true}},model,contextWindow:4096,maxOutputTokens:128})
 try{await service.submit('main','hello',new AbortController().signal);expect(seen).toBe(true);expect(requestText).toContain('Original instruction fixture');expect(binding!()).toBe(true);await service.closeSession('main');expect(binding!()).toBe(false)}finally{await service.close();await environment.close();await coordinator.close()}
},30000)

it('rejects foreign execution before acquiring host authority or retaining resources',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'instruction-foreign-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'owner'});await coordinator.create({sessionId:'foreign'})
 const {createExecutorExecutionCache}=await import('../../session-executor/src/durable-session.ts');const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('owner'),environment=createInstructionEnvironment({settingsPath:join(root,'settings.json')});let effects=0
 const acquire=createOwnedGatewayInstructions({workspace:root,environment,authorityFor:async()=>{effects++;return ()=>({kind:'unbound' as const,revision:'r',workspaceRoot:root})}})
 try{await expect(acquire('foreign',entry.execution,()=>{effects++})).rejects.toThrow();expect(effects).toBe(0)}finally{await cache.closeAll();await environment.close();await coordinator.close()}
},30000)
