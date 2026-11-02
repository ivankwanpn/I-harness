import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createOwnedIndexJobs} from '../src/owned-index-jobs.ts'

it('registers index work on the actual staged Task jobs and joins completion',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-index-runtime-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}});let owner:ReturnType<typeof createOwnedIndexJobs>|undefined
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],ownedTask:{async options(original){const exec=registerExec(original.ctx);original.retain(()=>exec.dispose());return {exec,resolveModel:async()=>({status:'unconfigured' as const,reason:'fixture'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),persist:{coordinator,stateId:'main',parentSessionId:'main'}}}},async mountDefaultSurface(original,live){owner=createOwnedIndexJobs(original,live.task!);return {systemPrompt:()=> 'system',modelToolSchemas:live.modelToolSchemas,modelOverheadTokens:()=>10,async prepareInput(text){return text},async reconcileAuthority(){original.assertCurrent()}}}},model,contextWindow:4096,maxOutputTokens:128})
 try{await service.submit('main','hello',new AbortController().signal);let cancelled=0;const registration=owner!.register({id:'index',kind:'code-context',label:'index',cancel(){cancelled++}});expect(owner!.owns('main')).toBe(true);let closed=false;const closing=service.closeSession('main').then(()=>{closed=true});await new Promise(resolve=>setTimeout(resolve,0));expect(cancelled).toBe(1);expect(closed).toBe(false);registration.finish('killed','cancelled');await closing;expect(closed).toBe(true)}finally{await service.close();await coordinator.close()}
},30000)
