import {expect,it} from 'vitest'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createInstructionEnvironment} from '../../session-executor/src/context/instructions/index.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createOwnedGatewayInstructions} from '../src/owned-gateway-instructions.ts'
import {createOwnedGatewayNative} from '../src/owned-gateway-native.ts'
import {createDesktopRewind} from '../src/rewind.ts'

it('records original managed filesystem preimage and restores through the same Rewind owner',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-rewind-')),sessions=join(root,'sessions');await writeFile(join(root,'greet.txt'),'before')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(sessions),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const authorityFor=async()=>()=>({kind:'unbound' as const,revision:'r',workspaceRoot:root}),environment=createInstructionEnvironment({settingsPath:join(root,'settings.json')}),native=createOwnedGatewayNative({authorityFor,mode:()=> 'workspace-write',executionOptions:()=>({windowsSandboxBackend:'legacy'}),resolveShell:async()=>()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'}),resultOptions:id=>({workspace:root,coordinator,sessionId:id})})
 let calls=0;const model=controlledModel(async function*(){if(calls++===0)yield {type:'tool_call',call:{id:'write',name:'write',args:{path:'greet.txt',text:'after'}}};else yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],originalFilesystem:true,requireFilesystemPolicy:true,approvalMode:'full-access',ownedRewind:{root:sessions,workspace:root},acquireInstructions:createOwnedGatewayInstructions({workspace:root,environment,authorityFor}),ownedShell:{...native,agentShell:()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'})}},model,contextWindow:32000,maxOutputTokens:128}),rewind=createDesktopRewind(sessions,root,coordinator,service)
 try{await service.submit('main','rewrite',new AbortController().signal);expect(await readFile(join(root,'greet.txt'),'utf8')).toBe('after');const plan=await rewind.plan('main',0,'all');expect(plan.ops).toMatchObject([{path:'greet.txt',kind:'restore-blob'}]);await rewind.execute('main',0,'all',plan.fingerprint);expect(await readFile(join(root,'greet.txt'),'utf8')).toBe('before');await service.submit('main','continue',new AbortController().signal);expect(calls).toBe(3)}finally{await service.close();await environment.close();await coordinator.close()}
},30000)
