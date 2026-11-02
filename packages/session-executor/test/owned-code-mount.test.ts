import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContextOutputService} from '@i-harness/context-output'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createManagedExecutionRuntimeWithRegistry} from '../src/managed-assembly.ts'
import {mountOwnedCode} from '../src/owned-code.ts'

it('mounts the original private Code tools and retains their disposal',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-code-mount-'))
 const c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract);await c.create({sessionId:'main'})
 const execution=await acquireManagedExecution(c,'main'),output=createContextOutputService({root:join(root,'results'),workspaceId:'fixture',config:{enabled:false}}),cleanups:Array<()=>Promise<void>>=[]
 const model={async *stream(){yield {type:'end' as const}}} as any
 try{
  const runtime=await createManagedExecutionRuntimeWithRegistry({execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:fn=>cleanups.push(fn),configureRegistry:async original=>{await mountOwnedCode(original,{service:output,sourceFor:async()=>({sourceId:'owned-code-source'})},{mode:'mixed'})},resolveModel:()=>({model})})
  expect(runtime.tools.get('code_exec')).toBeDefined();await runtime.close()
  for(const cleanup of cleanups.reverse())await cleanup()
  expect(runtime.tools.get('code_exec')).toBeUndefined()
 }finally{await output.close();await c.close()}
},30000)
