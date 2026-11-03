import {expect,it} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {waterfallExecutionEvent} from '@i-harness/core-plugin'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createInstructionEnvironment} from '../../session-executor/src/context/instructions/index.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createOwnedGatewayInstructions} from '../src/owned-gateway-instructions.ts'
import {mountOwnedGatewayGuardian} from '../src/owned-gateway-guardian.ts'

it('mounts isolated Guardian on the original Task registry with configured instructions',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-guardian-'));await writeFile(join(root,'AGENTS.md'),'ORIGINAL_GUARDIAN_RULE')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const environment=createInstructionEnvironment({settingsPath:join(root,'settings.json')}),authority=()=>({kind:'unbound' as const,revision:'r',workspaceRoot:root}),acquire=createOwnedGatewayInstructions({workspace:root,environment,authorityFor:async()=>authority})
 let turns=0,effects=0,reviewText='';const model=controlledModel(async function*(){if(turns++===0)yield {type:'tool_call',call:{id:'call',name:'write_probe',args:{}}};else yield {type:'text/chunk',text:'done'};yield {type:'end'}}),reviewer=controlledModel(async function*(request){reviewText=JSON.stringify(request);yield {type:'text/chunk',text:'{"outcome":"approve","rationale":"safe","risk_level":"none"}'};yield {type:'end'}})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],acquireInstructions:acquire,ownedTask:{async options(original){const exec=registerExec(original.ctx);original.retain(()=>exec.dispose());return {exec,resolveModel:async()=>({status:'unconfigured' as const,reason:'fixture'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),persist:{coordinator,stateId:'main',parentSessionId:'main'}}}},async mountDefaultSurface(original,live){original.tools.register({name:'write_probe',description:'probe',inputSchema:{type:'object'},async execute(){effects++;return 'done'}});waterfallExecutionEvent(original.ctx,'tools/pre-execute',async(payload,next)=>{const result=await next(payload);return (payload as {name?:string}).name==='write_probe'?{kind:'ask',reason:'controlled'}:result});await mountOwnedGatewayGuardian(original,live.task!,{get parentModel(){return live.modelBinding().model},model:reviewer,resolveModel:async()=>({status:'unconfigured',reason:'fixture'})});return {systemPrompt:()=> 'system',modelToolSchemas:live.modelToolSchemas,modelOverheadTokens:()=>10,async prepareInput(text){return text},async reconcileAuthority(){original.assertCurrent()}}}},model,contextWindow:32000,maxOutputTokens:128})
 try{await service.submit('main','please write',new AbortController().signal);expect(effects).toBe(1);expect(reviewText).toContain('ORIGINAL_GUARDIAN_RULE')}finally{await service.close();await environment.close();await coordinator.close()}
},30000)
