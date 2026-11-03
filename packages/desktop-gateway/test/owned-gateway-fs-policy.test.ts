import {expect,it} from 'vitest'
import {mkdtemp,access} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createInstructionEnvironment} from '../../session-executor/src/context/instructions/index.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createOwnedGatewayInstructions} from '../src/owned-gateway-instructions.ts'
import {createOwnedGatewayNative} from '../src/owned-gateway-native.ts'

it('enforces the original read-only native policy on managed filesystem writes',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-fs-policy-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const authorityFor=async()=>()=>({kind:'unbound' as const,revision:'r',workspaceRoot:root}),environment=createInstructionEnvironment({settingsPath:join(root,'settings.json')}),native=createOwnedGatewayNative({authorityFor,mode:()=> 'read-only',executionOptions:()=>({windowsSandboxBackend:'legacy'}),resolveShell:async()=>()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'}),resultOptions:id=>({workspace:root,coordinator,sessionId:id})})
 let calls=0,request='';const model=controlledModel(async function*(value){request=JSON.stringify(value);if(calls++===0)yield {type:'tool_call',call:{id:'write',name:'write',args:{path:'forbidden.txt',text:'must not write'}}};else yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],originalFilesystem:true,requireFilesystemPolicy:true,approvalMode:'full-access',acquireInstructions:createOwnedGatewayInstructions({workspace:root,environment,authorityFor}),ownedShell:{...native,agentShell:()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'})}},model,contextWindow:32000,maxOutputTokens:128})
 try{await service.submit('main','write',new AbortController().signal);await expect(access(join(root,'forbidden.txt'))).rejects.toThrow();expect(request).toContain('FS_SANDBOX_DENIED')}finally{await service.close();await environment.close();await coordinator.close()}
},30000)

it('refuses reference-root writes and rejects policy capture when authority narrows reentrantly',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-fs-reference-')),reference=join(root,'ref'),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const {createExecutorExecutionCache}=await import('../../session-executor/src/durable-session.ts'),{originalFilesystemPolicyFor}=await import('../../session-executor/src/execution-runtime.ts');const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>void|Promise<void>>=[];let narrowed=false,reads=0
 const authorityFor=async()=>()=>{reads++;return {kind:'bound' as const,revision:narrowed&&reads>1?'narrow':'r',primaryRoot:root,roots:narrowed&&reads>1?[]:[root],references:[reference]}}
 const native=createOwnedGatewayNative({authorityFor,mode:()=> 'workspace-write',executionOptions:()=>({windowsSandboxBackend:'legacy'}),resolveShell:async()=>()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'}),resultOptions:id=>({workspace:root,coordinator,sessionId:id})})
 try{const host=await native.acquireExecution('main',cleanup=>cleanups.push(cleanup),entry.execution),policy=originalFilesystemPolicyFor(host,entry.execution)!;expect(()=>policy.writeGuard(join(reference,'file'))).toThrow(/Readonly reference/);reads=0;narrowed=true;expect(()=>policy.sandboxPolicy()).toThrow(/authority|changed/i)}finally{for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close()}
},30000)
