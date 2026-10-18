import { afterEach as afterFixture, vi as fixtureVi } from 'vitest'
afterFixture(() => fixtureVi.unstubAllGlobals())
import { createGenerationLifecycle } from "../src/lifecycle/generation-actions.ts"
import { controlledModel } from "./controlled-model.ts"
import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent } from '@i-harness/core-agent'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { installNativeContextOutput } from '../src/context-output.ts'
import { createNativeCodeTextRetention } from '../src/context-output.ts'
import { registerCodeMode } from '@i-harness/code-mode'

it('refuses result references through generic metadata even with a runtime cast and accepts the actual narrow source',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ih-f1-ref-port-')),backend=createJsonlBackend(join(root,'sessions')),coordinator=createSessionCoordinator(backend,{lock:{enabled:true}})
  const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id)
  const service=createContextOutputService({root:join(root,'context'),workspaceId:'fixture',config:{enabled:true}})
  try{
    const ref=await service.capture({sessionId:id,callId:'actual',label:'actual',text:'the actual returned body',complete:true})
    expect(ref).toBeDefined()
    const event={type:'context/result-ref',ignorable:true,ref} as const
    const compileBoundary=(facts:typeof document.metadata)=>{
      // @ts-expect-error result references require the registered real source
      void facts.admit({...event,ref:ref!})
    }
    void compileBoundary
    expect(await Reflect.apply(document.metadata.admit,document.metadata,[event])).toEqual({kind:'not-issued',code:'FACT_INVALID_GROUP'})
    expect(document.view.events).toEqual([])
    const action=document.beginAction(),source=action.registerSettlementSource(async()=>{})
    expect((await source.retention.capture({...event,ref:ref!}).admit()).kind).toBe('committed')
    await source.close();action.finish()
    expect(document.view.events.map(event=>event.type)).toEqual(['context/result-ref'])
  }finally{await coordinator.close();await service.close()}
})

it.each([true,false])('retains the actual after-next output and exact reference until its journal receipt without rerunning or fabricating a result (unresolved=%s)', async holdReconcile => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-context-outcome-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'context'), workspaceId: 'fixture', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  installNativeContextOutput(ctx, { service, session: document.view, factOwner: document, sessionId: id })
  const raw = 'the real original body '.repeat(2000)
  let bodies = 0, finalizations = 0, sends = 0, captures = 0, key: BatchKey | undefined, blocked=holdReconcile
  const capture = service.capture.bind(service)
  service.capture = async (...args) => { captures++; return capture(...args) }
  tools.register({ name: 'long_text', description: '', inputSchema: {}, execute: async () => { bodies++; return raw } })
  ctx.on('tools/post-execute', () => { finalizations++ })
  const actual = backend.appendOwnedBatch!
  const reconcile=backend.reconcileOwnedBatch!
  backend.reconcileOwnedBatch=async(...args)=>blocked?{kind:'unknown',key:args[3].key}:reconcile(...args)
  backend.appendOwnedBatch = async (...args) => {
    const outcome = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/result-ref')) { key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(document.view, id, action), session: document.view, factOwner: document, tools, sessionId: id, systemPrompt: '', model: controlledModel(async function* () {
    sends++; yield { type: 'tool_call', call: { id: 'outer', name: 'long_text', args: {} } }; yield { type: 'end' }
  }) })
  try {
    await expect(agent.run('read the real output')).rejects.toThrow()
    expect([bodies, captures, finalizations, sends]).toEqual([1, 1, holdReconcile?0:1, 1])
    expect(key).toBeDefined()
    expect(document.view.events.some(event => event.type === 'context/result-ref' || event.type === 'tool/result')).toBe(!holdReconcile)
    if(holdReconcile){blocked=false;await document.reconcile(key!)}
    document.revokeNewWork(); await document.close()
    const events = (await backend.read(id)).events
    const refs = events.filter(event => event.type === 'context/result-ref')
    const results = events.filter(event => event.type === 'tool/result')
    expect(refs).toHaveLength(1); expect(results).toHaveLength(1)
    expect(results[0]!.output).toMatchObject({ contextRef: { id: refs[0]!.ref.id } })
    expect(results[0]!.output).not.toHaveProperty('code', 'TOOL_FAILED')
    let recovered = ''
    while (Buffer.byteLength(recovered) < Buffer.byteLength(raw)) {
      const part = await service.read({ sessionId: id }, { refId: refs[0]!.ref.id, offset: Buffer.byteLength(recovered) })
      expect(part.text.length).toBeGreaterThan(0); recovered += part.text
    }
    expect(recovered === raw).toBe(true)
    expect([bodies, captures, finalizations, sends]).toEqual([1, 1, 1, 1])
  } finally { await coordinator.close().catch(() => {}); await service.close() }
})

it('retains a real emitted-text observation through reference uncertainty and Stop with one capture and the same window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-emitted-ref-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'context'), workspaceId: 'fixture', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let sends = 0, captures = 0, finalizations = 0, key: BatchKey | undefined, blocked=true
  const capture = service.capture.bind(service)
  service.capture = async (...args) => { captures++; return capture(...args) }
  ctx.on('tools/post-execute', () => { finalizations++ })
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' }, retainText: createNativeCodeTextRetention({ service, session: document.view, sessionId: id }) })
  const actual = backend.appendOwnedBatch!
  const reconcile=backend.reconcileOwnedBatch!
  backend.reconcileOwnedBatch=async(...args)=>blocked?{kind:'unknown',key:args[3].key}:reconcile(...args)
  backend.appendOwnedBatch = async (...args) => {
    const outcome = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/result-ref')) { key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(document.view, id, action), session: document.view, factOwner: document, tools, sessionId: id, systemPrompt: '', model: controlledModel(async function* () {
    sends++; yield { type: 'tool_call', call: { id: 'outer', name: 'code_exec', args: { code: 'text("original emitted window ".repeat(2000));', yield_time_ms: 5000, max_output_tokens: 16 } } }; yield { type: 'end' }
  }) })
  try {
    await expect(agent.run('emit the original window')).rejects.toThrow()
    expect([captures, finalizations, sends]).toEqual([1, 0, 1]); expect(key).toBeDefined()
    await mount.cancel('human Stop during reference recovery')
    blocked=false;await document.reconcile(key!)
    document.revokeNewWork(); await document.close()
    const events = (await backend.read(id)).events
    const refs = events.filter(event => event.type === 'context/result-ref'), results = events.filter(event => event.type === 'tool/result')
    expect(refs).toHaveLength(1); expect(results).toHaveLength(1)
    expect(results[0]!.output).toMatchObject({ status: 'completed', text: expect.stringContaining('original emitted'), textRetention: { contextRef: { id: refs[0]!.ref.id }, complete: true } })
    expect([captures, finalizations, sends]).toEqual([1, 1, 1])
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await service.close() }
})

it('keeps actor and parent emitted-text reference dispositions independent through two unknown receipts and close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-parent-emitted-ref-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const parentId = (await coordinator.create()).id, actorId = (await coordinator.create()).id
  const parent = await coordinator.openManagedDocument(parentId), actor = await coordinator.openManagedDocument(actorId)
  const service = createContextOutputService({ root: join(root, 'context'), workspaceId: 'fixture', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx), keys = new Map<string, BatchKey>(), blocked=new Set([actorId,parentId])
  let captures = 0, finalizations = 0, sends = 0
  const capture = service.capture.bind(service)
  service.capture = async (...args) => { captures++; return capture(...args) }
  ctx.on('tools/post-execute', () => { finalizations++ })
  const mount = registerCodeMode(ctx, tools, { session: actor.view, sessionId: actorId, factOwner: actor, config: { mode: 'mixed' }, retainText: createNativeCodeTextRetention({ service, session: actor.view, sessionId: actorId, parent: { sessionId: parentId, session: parent.view, factOwner: parent } }) })
  const actual = backend.appendOwnedBatch!
  const reconcile=backend.reconcileOwnedBatch!
  backend.reconcileOwnedBatch=async(...args)=>blocked.has(args[0])?{kind:'unknown',key:args[3].key}:reconcile(...args)
  backend.appendOwnedBatch = async (...args) => {
    const outcome = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/result-ref')) { keys.set(args[0], args[3].key); return { kind: 'unknown', key: args[3].key } }
    return outcome
  }
  const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(parent.view, parentId, action), session: parent.view, factOwner: parent, tools, sessionId: parentId, systemPrompt: '', model: controlledModel(async function* () {
    sends++; yield { type: 'tool_call', call: { id: 'outer', name: 'code_exec', args: { code: 'text("same emitted original ".repeat(2000));', yield_time_ms: 5000, max_output_tokens: 16 } } }; yield { type: 'end' }
  }) })
  try {
    await expect(agent.run('emit once for both documents')).rejects.toThrow()
    expect(keys.has(actorId)).toBe(true); expect(keys.has(parentId)).toBe(false)
    await mount.cancel('Stop after the real window')
    blocked.delete(actorId);await actor.reconcile(keys.get(actorId)!)
    await expect(mount.dispose()).rejects.toThrow()
    expect(keys.has(parentId)).toBe(true)
    expect(parent.view.events.some(event => event.type === 'context/result-ref' || event.type === 'tool/result')).toBe(false)
    blocked.delete(parentId);await parent.reconcile(keys.get(parentId)!)
    parent.revokeNewWork(); await parent.close(); await mount.dispose(); await actor.close()
    const parentEvents = (await backend.read(parentId)).events, actorEvents = (await backend.read(actorId)).events
    const parentRefs = parentEvents.filter(event => event.type === 'context/result-ref'), actorRefs = actorEvents.filter(event => event.type === 'context/result-ref')
    expect(parentRefs).toHaveLength(1); expect(actorRefs).toHaveLength(1)
    expect(parentRefs[0]!.ref.id).toBe(actorRefs[0]!.ref.id)
    expect(parentEvents.filter(event => event.type === 'tool/result')).toEqual([expect.objectContaining({ output: expect.objectContaining({ status: 'completed', text: expect.stringContaining('same emitted original'), textRetention: expect.objectContaining({ contextRef: expect.objectContaining({ id: actorRefs[0]!.ref.id }) }) }) })])
    expect([captures, finalizations, sends]).toEqual([1, 1, 1])
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await service.close() }
})
