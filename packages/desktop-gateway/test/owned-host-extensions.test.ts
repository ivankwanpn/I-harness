import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createRoleRegistry } from '@i-harness/subagent'
import { askUser, listCommands } from '@i-harness/interaction'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createExecutorExecutionCache } from '../../session-executor/src/durable-session.ts'
import { createManagedExecutionRuntimeWithRegistry } from '../../session-executor/src/managed-assembly.ts'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createInteractionBridge } from '../src/interaction.ts'
import { createApprovalRulesAdapter } from '../src/approval-rules.ts'
import { mountOwnedHostExtensions } from '../src/owned-host-extensions.ts'

it('mounts the real catalog and interaction on the original managed registry and retires them', async () => {
 const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'owned-host-'))
 const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), {lock:{enabled:true}}, taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache = createExecutorExecutionCache({coordinator}), entry = await cache.get('main')
 const cleanups: Array<()=>void|Promise<void>> = []
 let identity: (()=>{workspaceId:string;revision:string}|undefined)|undefined
 const rules = createApprovalRulesAdapter({filePath:join(root,'rules.json'),policyIdentity:()=>undefined,ownedPolicyIdentity:()=>identity?.()})
 const bridge = createInteractionBridge(()=>{}, {approvalRules:rules})
 const model = controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 let mounted: Awaited<ReturnType<typeof mountOwnedHostExtensions>>|undefined
 try {
  const runtime = await createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:c=>cleanups.push(c),
   async configureRegistry(original){ mounted = await mountOwnedHostExtensions(original,{roles:createRoleRegistry(),workspace:root,configDir:root,startSource:'startup',report(){},interaction:bridge,modelTools:()=>[],policy:()=>({workspace:root,sandbox:'workspace-write',approval:'ask',project:()=>undefined,hookConfigs:[],grantPaths:[],pluginAuthority:{}}),bindIdentity(_owner,get){identity=get},inputs:{skillDirs:[],mcpServerConfigs:{},agentDescriptors:[],hookConfigs:[],commandDescriptors:[{name:'greet',body:'hello $ARGUMENTS'}]}}) },resolveModel(){return {model}}})
  expect(mounted!.identity()).toBeDefined()
  expect(await mounted!.mount.expand('/greet world')).toBe('hello world')
  const answer = askUser(runtime.ctx,{id:'q',prompt:'Question?'})
  const pending = bridge.pending('main')[0]!
  bridge.reply({sessionId:'main',requestId:pending.requestId,decision:{kind:'question',answer:'yes'}})
  expect(await answer).toBe('yes')
  await runtime.close()
  for(const cleanup of cleanups.reverse()) await cleanup()
  expect(listCommands(runtime.ctx)).toEqual([])
 } finally { bridge.close(); await cache.closeAll(); await coordinator.close() }
},30000)
