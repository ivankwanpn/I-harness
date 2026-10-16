import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createSession, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createAgentTable, createJobRegistry, spawnChild } from '@i-harness/subagent'
import { createDurabilityProbes } from '../src/scheduler/recovery.ts'
import { retainInitialInput } from '../../subagent/src/child/initial-input.ts'

it.each(['pending','unknown'] as const)('preserves exact initial-input evidence through a later %s frame and refuses foreign or missing owner evidence', async mode=>{
  const root=await mkdtemp(join(tmpdir(),'ih-f1-initial-proof-')),backend=createJsonlBackend(root),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}})
  const table=createAgentTable(),jobs=createJobRegistry(),agents=createAgentRegistry(),ctx=createContext(),tools=createToolRegistry(ctx)
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),modelRelease=Promise.withResolvers<void>(),actual=backend.appendOwnedBatch!
  let key:BatchKey|undefined
  backend.appendOwnedBatch=async(...args)=>{
    if(decodeFactBatch(args[3].bytes).events.some(event=>event.type==='turn/start')){
      key=args[3].key;entered.resolve()
      if(mode==='pending')await release.promise
      const outcome=await actual(...args)
      return mode==='unknown'?{kind:'unknown',key}:outcome
    }
    return actual(...args)
  }
  const out=await spawnChild({taskName:'proof',message:'exact initial prompt',parentPath:'lead',parentCtx:ctx,parentSession:createSession(),parentRegistry:tools,role:{name:'fixture',description:'',systemPrompt:'',tools:[]},parentModel:{async *stream(){await modelRelease.promise;yield{type:'end'}}},resolveModel:async()=>({status:'unconfigured',reason:'unused'}),table,jobs,agents,childSessions:{coordinator,parentSessionId:'parent'}})
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
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(false)
    release.resolve()
    if(mode==='unknown'){await entry.followupChain;await (await coordinator.openManagedDocument(out.sessionId!)).reconcile(key!)}
    else {modelRelease.resolve();await entry.followupChain}
    expect(await probe.realHoldsPrompt(out.sessionId!)).toBe(true)
  }finally{release.resolve();modelRelease.resolve();table.add(out.path,entry);await entry.dispose?.().catch(()=>{});await coordinator.close().catch(()=>{})}
})

it('refuses an actual unrelated admission or foreign receipt as the private initial-input evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-wrong-initial-proof-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx), table = createAgentTable()
  const out = await spawnChild({ taskName: 'proof', message: 'actual initial input', parentPath: 'lead', parentCtx: ctx, parentSession: createSession(), parentRegistry: tools,
    role: { name: 'fixture', description: '', systemPrompt: '', tools: [] }, parentModel: { async *stream() { yield { type: 'end' } } },
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
