import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {captureExecutionHookChannel} from '@i-harness/core-plugin'
import {committedFactSeqs} from '@i-harness/core-session'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createExecutorExecutionCache} from '../../session-executor/src/durable-session.ts'
import {createOwnedMetadataFold} from '../../session-executor/src/lifecycle/owned-metadata-fold.ts'
import {actionMetadataFacts} from '../../session-executor/src/lifecycle/action-facts.ts'
import {createManagedExecutionRuntimeWithRegistry} from '../../session-executor/src/managed-assembly.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createOwnedDefaultSurface,type OwnedDefaultSurface} from '../src/owned-default-surface.ts'

it('uses original plan and metadata, live prompt and schemas, and preserves an existing off state',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'default-surface-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>void|Promise<void>>=[]
 committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'plan/mode',mode:'off'}))
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 let surface:OwnedDefaultSurface|undefined, section='policy one', original:any
 try {
  const runtime=await createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:c=>cleanups.push(c),async configureRegistry(value){original=value;surface=await createOwnedDefaultSurface(value,{initialPlanMode:true,policyPrompt:()=>section,shellPrompt:()=>'',projectPrompt:()=>'',hookPrompt:()=>'',recoveryPrompt:()=>'',skillsPrompt:()=>'',rolesPrompt:()=>'',schemas:()=>value.tools.schemas(),prepareInput:async text=>`expanded ${text}`,reconcileAuthority:async()=>{},goalChanged(){}})},resolveModel(){return {model}}})
  expect(entry.execution.observe().plan().active).toBe(false)
  expect(surface!.systemPrompt()).toContain('policy one')
  const before=surface!.modelOverheadTokens();section='policy two '.repeat(100)
  original.tools.register({name:'extra',description:'extra live schema',inputSchema:{type:'object'},isReadOnly:true,async execute(){return 'ok'}})
  expect(surface!.systemPrompt()).toContain('policy two')
  expect(surface!.modelToolSchemas().some((s:any)=>s.name==='extra')).toBe(true)
  expect(surface!.modelOverheadTokens()).toBeGreaterThan(before)
  expect(await surface!.prepareInput('/greet')).toBe('expanded /greet')
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'plan/mode',mode:'on'}))
  expect(surface!.systemPrompt()).toContain('PLAN MODE')
  await expect(captureExecutionHookChannel(runtime.ctx).emit('tools/pre-execute',{name:'unknown'})).rejects.toThrow('read-only')
  const exit=original.tools.get('exit_plan_mode')!
  expect(await exit.execute({}, {abortSignal:new AbortController().signal} as any)).toEqual({active:true})
  expect(entry.execution.observe().plan().active).toBe(false)
  expect(await exit.execute({}, {abortSignal:new AbortController().signal} as any)).toEqual({active:false})
  await runtime.close()
 } finally {for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close()}
},30000)
