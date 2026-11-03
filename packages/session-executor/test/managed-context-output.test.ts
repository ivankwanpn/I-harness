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
import { createCodeTextRetention } from '../src/lifecycle/code-text-retention.ts'
import type { CodeModeTextRetention } from '@i-harness/code-mode'
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

it('retains one real emitted-text observation as a managed artifact and keeps it readable after Stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-emitted-ref-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'context'), workspaceId: 'fixture', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let sends = 0, calls = 0, finalizations = 0
  ctx.on('tools/post-execute', () => { finalizations++ })
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' }, retainText: createCodeTextRetention({ service, sessionId: id }) })
  const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(document.view, id, action), session: document.view, factOwner: document, tools, sessionId: id, systemPrompt: '', model: controlledModel(async function* () {
    if (++sends === 1) { calls++; yield { type: 'tool_call', call: { id: 'outer', name: 'code_exec', args: { code: 'text("original emitted window ".repeat(2000));', yield_time_ms: 5000, max_output_tokens: 16 } } } }
    else yield { type: 'text/chunk', text: 'done' }
    yield { type: 'end' }
  }) })
  try {
    await agent.run('emit the original window')
    await mount.cancel('human Stop after the real window')
    document.revokeNewWork(); await document.close()
    const events = (await backend.read(id)).events
    // No legacy reference fact: the bounded envelope in the committed tool
    // result is the only published handle.
    expect(events.filter(event => event.type === 'context/result-ref')).toEqual([])
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    const output = results[0]!.output as { status: string; text: string; textRetention: CodeModeTextRetention }
    expect(output.status).toBe('completed')
    expect(output.text).toContain('original emitted')
    const retention = output.textRetention
    expect(retention).toMatchObject({ stored: true, complete: true })
    const ref = retention.envelope?.retention.kind === 'artifact' ? retention.envelope.retention.ref : undefined
    expect(ref).toMatchObject({ codec: 'json-utf8-v1', completeness: 'complete' })
    let offset = 0, encoded = ''
    for (;;) {
      const page = await service.readResult({ sessionId: id }, { ref: ref!, offset })
      if (page.data.kind !== 'text') throw new Error('Expected a text page')
      encoded += page.data.text
      if (page.eof) break
      offset = page.nextOffset!
    }
    expect(JSON.parse(encoded)).toBe('original emitted window '.repeat(2000))
    expect([calls, finalizations]).toEqual([1, 1])
    expect([sends, finalizations]).toEqual([2, 1])
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await service.close() }
})

it('keeps emitted-text artifact ownership with the acting document and grants another session nothing implicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-emitted-owner-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const emitterId = (await coordinator.create()).id, otherId = (await coordinator.create()).id
  const emitter = await coordinator.openManagedDocument(emitterId), other = await coordinator.openManagedDocument(otherId)
  const service = createContextOutputService({ root: join(root, 'context'), workspaceId: 'fixture', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let sends = 0, calls = 0, finalizations = 0
  ctx.on('tools/post-execute', () => { finalizations++ })
  const mount = registerCodeMode(ctx, tools, { session: emitter.view, sessionId: emitterId, factOwner: emitter, config: { mode: 'mixed' }, retainText: createCodeTextRetention({ service, sessionId: emitterId }) })
  const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(emitter.view, emitterId, action), session: emitter.view, factOwner: emitter, tools, sessionId: emitterId, systemPrompt: '', model: controlledModel(async function* () {
    if (++sends === 1) { calls++; yield { type: 'tool_call', call: { id: 'outer', name: 'code_exec', args: { code: 'text("same emitted original ".repeat(2000));', yield_time_ms: 5000, max_output_tokens: 16 } } } }
    else yield { type: 'text/chunk', text: 'done' }
    yield { type: 'end' }
  }) })
  try {
    await agent.run('emit once for the acting document')
    emitter.revokeNewWork(); await emitter.close(); other.revokeNewWork(); await other.close()
    const emitterEvents = (await backend.read(emitterId)).events, otherEvents = (await backend.read(otherId)).events
    expect(emitterEvents.filter(event => event.type === 'context/result-ref')).toEqual([])
    expect(otherEvents.filter(event => event.type === 'tool/result')).toEqual([])
    const result = emitterEvents.filter(event => event.type === 'tool/result')[0]!
    const retention = (result.output as { textRetention: CodeModeTextRetention }).textRetention
    const ref = retention.envelope?.retention.kind === 'artifact' ? retention.envelope.retention.ref : undefined
    expect(ref).toBeDefined()
    // The emitting document's pin is the only read authority; a different
    // session cannot read the body just because it knows the ref shape.
    const page = await service.readResult({ sessionId: emitterId }, { ref: ref! })
    expect(page.data.kind).toBe('text')
    await expect(service.readResult({ sessionId: otherId }, { ref: ref! })).rejects.toThrow()
    expect([calls, finalizations]).toEqual([1, 1])
    expect(sends).toBeGreaterThanOrEqual(2)
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await service.close() }
})
