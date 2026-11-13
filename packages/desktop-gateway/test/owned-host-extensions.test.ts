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
 const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
 let hold = false, unknown = false
 const backend = createJsonlBackend(root, { wrapOwnedBatch: append => (...args) => {
   const writing = append(...args)
   if (!hold || !Buffer.from(args[3].bytes).toString('utf8').includes('policy-held')) return writing
   return writing.then(async outcome => { entered.resolve(); await release.promise; return unknown ? { kind: 'unknown' as const, key: args[3].key } : outcome })
 } })
 const coordinator = composeJsonlTaskTransitionCoordinator(backend, {lock:{enabled:true}}, taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache = createExecutorExecutionCache({coordinator}), entry = await cache.get('main')
 const cleanups: Array<()=>void|Promise<void>> = []
 const roles = createRoleRegistry()
 let identity: (()=>{workspaceId:string;revision:string}|undefined)|undefined
 const rules = createApprovalRulesAdapter({filePath:join(root,'rules.json'),policyIdentity:()=>undefined,ownedPolicyIdentity:()=>identity?.()})
 const bridge = createInteractionBridge(()=>{}, {approvalRules:rules})
 const model = controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 let mounted: Awaited<ReturnType<typeof mountOwnedHostExtensions>>|undefined
 try {
  const runtime = await createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:c=>cleanups.push(c),
   async configureRegistry(original){ mounted = await mountOwnedHostExtensions(original,{roles,workspace:root,configDir:root,startSource:'startup',report(){},interaction:bridge,policy:()=>({workspace:root,sandbox:'workspace-write',approval:'ask',project:()=>undefined,hookConfigs:[],grantPaths:[],pluginAuthority:{}}),bindIdentity(_owner,get){identity=get},inputs:{skillDirs:[],mcpServerConfigs:{},agentDescriptors:[],hookConfigs:[],commandDescriptors:[{name:'greet',body:'hello $ARGUMENTS'}]}}) },resolveModel(){return {model}}})
  expect(mounted!.identity()).toBeDefined()
  const originalIdentity = mounted!.identity()
  roles.register({ name: 'original-role', description: 'policy role', systemPrompt: 'original', tools: [] })
  expect(mounted!.identity()?.revision).not.toBe(originalIdentity?.revision)
  roles.remove('original-role')
  expect(mounted!.identity()).toEqual(originalIdentity)
  const action = entry.execution.owner.beginAction()
  const capture = action.captureMetadata!({ type: 'session/title', title: 'policy-held', source: 'user', messageSeqs: [] })
  hold = true
  const writing = capture.admit()
  try {
    await entered.promise
    expect(mounted!.identity()).toEqual(originalIdentity)
    unknown = true
    release.resolve()
    expect(await writing).toMatchObject({ kind: 'unknown' })
    expect(mounted!.identity()).toBeUndefined()
    hold = false; unknown = false
    expect(await capture.reconcile()).toMatchObject({ kind: 'committed' })
    expect(mounted!.identity()).toEqual(originalIdentity)
  } finally {
    release.resolve()
    hold = false
    unknown = false
    await writing
    action.finish()
  }
  expect(await mounted!.mount.expand('/greet world')).toBe('hello world')
  const answer = askUser(runtime.ctx,{id:'q',prompt:'Question?'})
  const pending = bridge.pending('main')[0]!
  bridge.reply({sessionId:'main',requestId:pending.requestId,decision:{kind:'question',answer:'yes'}})
  expect(await answer).toBe('yes')
  await runtime.close()
  for(const cleanup of cleanups.reverse()) await cleanup()
  expect(mounted!.identity()).toBeUndefined()
  expect(listCommands(runtime.ctx)).toEqual([])
 } finally { release.resolve(); bridge.close(); await cache.closeAll(); await coordinator.close() }
},30000)
