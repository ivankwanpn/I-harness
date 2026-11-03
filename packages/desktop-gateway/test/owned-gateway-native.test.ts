import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createExecutorExecutionCache} from '../../session-executor/src/durable-session.ts'
import {createOwnedGatewayNative} from '../src/owned-gateway-native.ts'
import {originalFilesystemPolicyFor} from '../../session-executor/src/execution-runtime.ts'
import {actionMetadataFacts} from '../../session-executor/src/lifecycle/action-facts.ts'
import {committedFactSeqs} from '@i-harness/core-session'

it('retains a session native execution and result lease against live project authority',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-native-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>void|Promise<void>>=[]
 let revoked=false
 const native=createOwnedGatewayNative({authorityFor:async()=>()=>revoked?{kind:'revoked',revision:'2',reason:'revoked'}:{kind:'bound',revision:'1',primaryRoot:root,roots:[root],references:[]},mode:()=> 'workspace-write',executionOptions:()=>({windowsSandboxBackend:'legacy'}),resolveShell:async()=>()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'}),resultOptions:id=>({workspace:root,coordinator,sessionId:id,projectContext:()=>({id:'p',roots:[root]})})})
 try{
  const execution=await native.acquireExecution('main',cleanup=>cleanups.push(cleanup),entry.execution)
  expect(execution.defaultOwner?.sessionId).toBe('main');expect(native.agentShellFor('main').command).toBe('sh');expect(originalFilesystemPolicyFor(execution,entry.execution)).toBeDefined();expect(originalFilesystemPolicyFor({...execution},entry.execution)).toBeUndefined()
  const policy=execution.resolvePolicy({sessionId:'main'},undefined);expect(policy.mode).toBe('workspace-write')
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'sandbox/mode',mode:'read-only'}))
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'sandbox/mode',mode:'workspace-write'}))
  expect(()=>execution.validateAuthority!(policy)).toThrow(/generation changed/)
  const output=await native.acquireOutput('main',cleanup=>cleanups.push(cleanup));expect(output.service).toBeDefined();expect(output.sourceFor).toBeDefined()
  revoked=true;expect(()=>execution.resolvePolicy({sessionId:'main'},undefined)).toThrow()
 }finally{for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close()}
},30000)

it('rejects a foreign session before authority or resource acquisition',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-foreign-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'owner'});await coordinator.create({sessionId:'foreign'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('owner');let effects=0
 const native=createOwnedGatewayNative({authorityFor:async()=>{effects++;return ()=>({kind:'unbound' as const,revision:'r',workspaceRoot:root})},mode:()=> 'workspace-write',executionOptions:()=>{effects++;return {}},resolveShell:async()=>{effects++;return ()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'})},resultOptions:id=>({workspace:root,coordinator,sessionId:id})})
 try{await expect(native.acquireExecution('foreign',()=>{effects++},entry.execution)).rejects.toThrow();expect(effects).toBe(0)}finally{await cache.closeAll();await coordinator.close()}
},30000)
