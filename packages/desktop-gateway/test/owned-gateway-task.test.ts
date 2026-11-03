import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createInstructionEnvironment} from '../../session-executor/src/context/instructions/index.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createOwnedGatewayInstructions} from '../src/owned-gateway-instructions.ts'
import {createOwnedGatewayNative} from '../src/owned-gateway-native.ts'
import {createOwnedGatewayTaskOptions} from '../src/owned-gateway-task.ts'

it('mounts staged Task over original configured instruction and native owners',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-task-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const environment=createInstructionEnvironment({settingsPath:join(root,'settings.json')}),authorityFor=async()=>()=>({kind:'unbound' as const,revision:'workspace',workspaceRoot:root})
 const instructions=createOwnedGatewayInstructions({workspace:root,environment,authorityFor}),native=createOwnedGatewayNative({authorityFor,mode:()=> 'workspace-write',executionOptions:()=>({windowsSandboxBackend:'legacy'}),resolveShell:async()=>()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'}),resultOptions:id=>({workspace:root,coordinator,sessionId:id})})
 const taskOptions=createOwnedGatewayTaskOptions({bindChildHost(){},coordinator,prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),resolveModel:async()=>({status:'unconfigured' as const,reason:'fixture'}),roleSelectionFor:()=>undefined,allowSubagentModelSelection:()=>false,autoCompactionEnabled:()=>false,childOptions:{}})
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}});let shared=false,activated=false,configReads=0,taskConfig:unknown;const codeConfig={mode:'off' as const}
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],acquireInstructions:instructions,ownedShell:{...native,agentShell:()=>({id:'fallback',label:'fallback',command:'cmd',dialect:'cmd'})},ownedTask:{async options(original,live){taskConfig=live.codeConfig;return taskOptions(original,live)}},ownedCode:{configFor(){configReads++;return codeConfig},acquireOutput:native.acquireOutput},async mountDefaultSurface(original,live){expect(original.instructions?.environment).toBe(environment);expect(live.task?.roles).toBeDefined();expect(original.tools.get('spawn_agent')).toBeDefined();const shell=original.tools.get('shell')!;expect(shell.commandDialect?.({command:'echo fixture'})).toBe('posix');shared=true;return {systemPrompt:()=> 'system',modelToolSchemas:live.modelToolSchemas,modelOverheadTokens:()=>10,async prepareInput(text){return text},async reconcileAuthority(){original.assertCurrent()},async activateAfterTaskReady(){await live.task!.ready;expect(live.modelBinding().model).toBe(model);activated=true}}}},model,contextWindow:32000,maxOutputTokens:128})
 try{await service.submit('main','hello',new AbortController().signal);expect(shared).toBe(true);expect(activated).toBe(true);expect(configReads).toBe(1);expect(taskConfig).not.toBe(codeConfig);expect(taskConfig).toEqual(codeConfig);expect(Object.isFrozen(taskConfig)).toBe(true)}finally{await service.close();await environment.close();await coordinator.close()}
},30000)
