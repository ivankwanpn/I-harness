import { fixtureGenerationFor, controlledModel } from '../../subagent/test/generation-fixture.ts'
import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createSession, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createAgentTable, createJobRegistry, spawnChild } from '@i-harness/subagent'
import { createDurabilityProbes } from '../src/scheduler/recovery.ts'
import { retainInitialInput } from '../../subagent/src/child/initial-input.ts'

it.each(['pending','unknown'] as const)('preserves exact initial-input evidence through a later %s frame and refuses foreign or missing owner evidence', async mode=>{
  const root=await mkdtemp(join(tmpdir(),'ih-f1-initial-proof-'))
  const table=createAgentTable(),jobs=createJobRegistry(),agents=createAgentRegistry(),ctx=createContext(),tools=createToolRegistry(ctx)
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),modelRelease=Promise.withResolvers<void>()
  let key:BatchKey|undefined
  let hook: ((original: NonNullable<import('@i-harness/session-persistence').PersistenceBackend['appendOwnedBatch']>) => NonNullable<import('@i-harness/session-persistence').PersistenceBackend['appendOwnedBatch']>) | undefined
  const backend=createJsonlBackend(root,{wrapOwnedBatch:original=>(...args)=>(hook?hook(original):original)(...args)})
  const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
  hook = actual => async(...args)=>{
    if(decodeFactBatch(args[3].bytes).events.some(event=>event.type==='turn/start')){
      key=args[3].key;entered.resolve()
      if(mode==='pending')await release.promise
      const outcome=await actual(...args)
      return mode==='unknown'?{kind:'unknown',key}:outcome
    }
    return actual(...args)
  }
  const out=await spawnChild({ generationFactoryFor: fixtureGenerationFor,taskName:'proof',message:'exact initial prompt',parentPath:'lead',parentCtx:ctx,parentSession:createSession(),parentRegistry:tools,role:{name:'fixture',description:'',systemPrompt:'',tools:[]},parentModel:controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {await modelRelease.promise;yield{type:'end'}}),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),table,jobs,agents,childSessions:{coordinator,parentSessionId:'parent'}})
  const entry=table.get(out.path)!,probe=createDurabilityProbes({table,childSessions:{coordinator,parentSessionId:'parent'}})
  try{
    await entered.promise
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(true)
    await expect(coordinator.snapshot!(out.sessionId!)).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
    const owner=entry.factOwner;entry.factOwner=undefined
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(false);entry.factOwner=owner
    const foreign=await coordinator.openManagedDocument((await coordinator.create()).id),view=entry.session
    entry.session=foreign.view;entry.factOwner=foreign
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(false);entry.session=view;entry.factOwner=owner
    // A copied entry cannot inherit the private historical admission evidence.
    table.add(out.path,{...entry})
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(false)
    table.add(out.path,entry)
    table.remove(out.path)
    // Without a live entry the probe falls back to the durable snapshot; if the
    // admission is already durable, honest evidence is true (legacy snapshot was
    // unavailable, which made this false).
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(mode === 'unknown')
    release.resolve()
    if(mode==='unknown'){await entry.followupChain;await (await coordinator.openManagedDocument(out.sessionId!)).reconcile(key!)}
    else {modelRelease.resolve();await entry.followupChain}
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(true)
  }finally{release.resolve();modelRelease.resolve();table.add(out.path,entry);await entry.dispose?.().catch(()=>{});await coordinator.close().catch(()=>{})}
})

it('refuses an actual unrelated admission or foreign receipt as the private initial-input evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-wrong-initial-proof-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const ctx = createContext(), tools = createToolRegistry(ctx), table = createAgentTable()
  const out = await spawnChild({ generationFactoryFor: fixtureGenerationFor, taskName: 'proof', message: 'actual initial input', parentPath: 'lead', parentCtx: ctx, parentSession: createSession(), parentRegistry: tools,
    role: { name: 'fixture', description: '', systemPrompt: '', tools: [] }, parentModel: controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { yield { type: 'end' } }),
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), table, jobs: createJobRegistry(), agents: createAgentRegistry(), childSessions: { coordinator, parentSessionId: 'parent' },
  })
  const entry = table.get(out.path)!, probe = createDurabilityProbes({ table, childSessions: { coordinator, parentSessionId: 'parent' } })
  try {
    await entry.followupChain
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(true)
    const action = entry.factOwner!.beginAction()
    const wrong = await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'wrong-source', text: 'unrelated saved user input', delivery: 'queue', intent: 'user', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'other.initial', originSessionId: 'parent' } })
    action.finish()
    // Only this test can call the private constructor directly; tool output
    // never exposes it or a receipt. A real unrelated admission is insufficient.
    retainInitialInput(entry, 'wrong-source', wrong)
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(false)
    const foreign = await coordinator.openManagedDocument((await coordinator.create()).id)
    const foreignOutcome = await foreign.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'foreign', text: 'foreign initial input', delivery: 'queue', intent: 'user', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.initial', originSessionId: 'parent' } })
    retainInitialInput(entry, 'foreign', foreignOutcome)
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(false)
  } finally { await entry.dispose?.(); await coordinator.close(); await ctx.scope.unmount() }
})
