import * as publicTools from '@i-harness/core-tools'
import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, assertResultPrepared, type Tool } from '@i-harness/core-tools'
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin'
import { committedFactSeqs } from '@i-harness/core-session'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createAgent } from '../src/index.ts'
import type { AgentGenerationLifecycle } from '../src/agent/generation.ts'
import { toolGenerationFactory } from '../src/agent/tool-generation.ts'
import { createAgentModelOriginOwner, consumeAgentModelOrigin } from '../src/tool-batch/model-origin.ts'
import { createLoopbackProvider } from './helpers/provider-loopback.ts'

const wire = (tool: boolean) => `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'original-model-code', function: { name: 'code_exec', arguments: '{}' } }] } : { content: 'done' }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`

it('allows queued Code lineage binding while auxiliary generation requires active dispatch', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'code-generation-preflight-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const parent = document.beginAction(), controller = new AbortController(), invocation = document.beginAction(controller.signal)
  const generation = createGenerationLifecycle(document.view, id, parent)
  const reachedOriginalOpen = new Error('Original nested lifecycle reached')
  const open = vi.fn<AgentGenerationLifecycle['open']>(async () => { throw reachedOriginalOpen })
  const localNestedLifecycle: AgentGenerationLifecycle = { open, async drain() {} }
  let parentGeneration: Awaited<ReturnType<typeof generation.open>> | undefined
  let scope: ReturnType<import('@i-harness/llm-seam').CodeGenerationLineage['forInvocation']> | undefined
  try {
    const [inputSeq] = committedFactSeqs(await parent.facts.inputs.admit({
      type: 'agent/input/admitted', version: 1, inputId: 'input', text: 'work', delivery: 'queue', intent: 'user',
      provenance: { kind: 'unknown', authority: 'unknown', scope: 'turn', producer: 'fixture' },
    }))
    parentGeneration = await generation.open('main', { kind: 'input', seq: inputSeq! })
    const call = { callId: 'outer', name: 'code_exec', args: {} }
    const [callSeq] = committedFactSeqs(await parent.facts.tools.call({ type: 'tool/call', ...call }))
    committedFactSeqs(await parent.facts.tools.dispatch(call.callId, { kind: 'prior', seq: callSeq!, expectedType: 'tool/call' }))
    committedFactSeqs(await parent.facts.code.record({ type: 'code/cell', cellId: 'cell', parentCallId: call.callId, state: 'started' }))
    const [eventSeq] = committedFactSeqs(await invocation.facts.code.record({ type: 'code/call', cellId: 'cell', parentCallId: call.callId, callId: 'inner', name: 'read_video', args: {} }))
    const toolGeneration = toolGenerationFactory({
      session: document.view, sessionId: id, factOwner: document, tools: createToolRegistry(createContext()),
      model: { stream() { throw new Error('Unexpected provider request') } },
      generationAction: parentGeneration, generationLifecycle: generation,
      generationFactory(action) { expect(action).toBe(invocation); return localNestedLifecycle },
    })!
    const lineage = toolGeneration({ ...call, eventSeq: callSeq }, parent.signal).codeLineage!.bindCell('cell')
    let queued = true, active = false
    scope = lineage.forInvocation({
      view: document.view, cellId: 'cell', action: invocation, eventSeq: eventSeq!, callId: 'inner', name: 'read_video', signal: invocation.signal,
      preflightCurrent: () => queued, current: () => active,
    })
    const approve = () => scope!.factories.approval({ timeoutMs: 1_000, selectedClient: () => undefined })
    const media = () => scope!.factories.media(1_000)
    await expect(approve()).rejects.toMatchObject({ code: 'GENERATION_STALE' })
    await expect(media()).rejects.toMatchObject({ code: 'GENERATION_STALE' })
    expect(open).not.toHaveBeenCalled()

    queued = false; active = true
    const [dispatchSeq] = committedFactSeqs(await invocation.facts.code.dispatch('cell', 'inner', { kind: 'prior', seq: eventSeq!, expectedType: 'code/call' }))
    await expect(approve()).rejects.toBe(reachedOriginalOpen)
    await expect(media()).rejects.toBe(reachedOriginalOpen)
    expect(open.mock.calls.map(([purpose, origin]) => [purpose, origin])).toEqual([
      ['approval', { kind: 'code', seq: eventSeq, parentActionId: parentGeneration.actionId }],
      ['media', { kind: 'code', seq: dispatchSeq, parentActionId: parentGeneration.actionId }],
    ])

    controller.abort()
    await expect(approve()).rejects.toMatchObject({ name: 'AbortError' })
    await expect(media()).rejects.toMatchObject({ name: 'AbortError' })
    expect(open).toHaveBeenCalledTimes(2)
    committedFactSeqs(await parent.facts.code.record({ type: 'code/cell', cellId: 'cell', parentCallId: call.callId, state: 'terminated' }))
  } finally {
    await scope?.close(); invocation.finish()
    await parentGeneration?.close('failed')
    await generation.drain(); parent.finish(); await coordinator.close()
  }
})

it.each([{captureWholeBatch:false,interference:'none'},{captureWholeBatch:true,interference:'none'},{captureWholeBatch:false,interference:'stop'},{captureWholeBatch:false,interference:'twice-next'},{captureWholeBatch:false,interference:'identity'}] as const)('a public fake Code tool cannot enroll source privilege ($captureWholeBatch / $interference)', async ({captureWholeBatch,interference}) => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'model-origin-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), origin = createAgentModelOriginOwner({ view: document.view, factOwner: document })
  const pair = createToolRegistryWithModelOrigin(ctx, { executionOwner: { view: document.view, factOwner: document, context: ctx, sessionId: id }, ...(captureWholeBatch ? { instructionsRequired: true } : {}) }, origin.verifier)
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(wire(true)) }, async response => { response.end(wire(false)) }])
  const controller = new AbortController()
  let armed = true
  ctx.onCascade('tools/execute', async (input: any, next) => {
    if (!armed || input.name !== 'code_exec') return next()
    armed = false
    if (interference === 'stop') controller.abort()
    if (interference === 'identity') input.exec.callId = 'foreign-member'
    const value = await next()
    if (interference === 'twice-next') return next()
    return value
  })
  const origins: boolean[] = []
  const bind=Reflect.get(publicTools,'bindPreparedCodeLeaf') as undefined|((tool:Tool,leaf:Tool['execute'])=>{enter(exec:import('@i-harness/core-tools').ToolExec):{hasCodeSourceIssuer():boolean}|undefined})
  let leaf:ReturnType<NonNullable<typeof bind>>|undefined
  const shell: Tool = { name: 'code_exec', description: 'original source control', inputSchema: { type: 'object' }, async execute(_args, exec) {
    const claim = leaf?.enter(exec)
    origins.push(!!claim?.hasCodeSourceIssuer())
    return 'observed'
  } }
  leaf = bind?.(shell, shell.execute)
  pair.registry.register(shell)
  const observedProofs: Array<{proof:object;expected:import('@i-harness/core-tools/model-origin').ModelOriginExpectation}> = []
  // Observe the original proof at its constructor-held driver boundary. The
  // actual paired driver still performs attachment to its private record.
  const driver: typeof pair.driver = { attach(prepared,proof) {
    const result = assertResultPrepared(prepared)
    const expected = {registry:pair.registry,prepared,view:document.view,source:result.source!,callId:prepared.exec.callId!,callEventSeq:prepared.exec.callEventSeq!,name:prepared.call.name,args:prepared.call.args}
    expect(()=>origin.verifier.take({...proof},expected)).toThrow()
    for(const changed of [{...expected,registry:{...pair.registry}},{...expected,prepared:{...prepared}},{...expected,source:{...result.source!}},{...expected,callId:'other'},{...expected,callEventSeq:expected.callEventSeq+1},{...expected,name:'other'},{...expected,args:{foreign:true}}]) expect(()=>origin.verifier.take(proof,changed)).toThrow()
    pair.driver.attach(prepared,proof)
    expect(()=>pair.driver.attach(prepared,proof)).toThrow()
    observedProofs.push({proof,expected})
  } }
  const binding = origin.bind(pair.registry, driver)
  expect(()=>consumeAgentModelOrigin({...binding},document.view,document,pair.registry)).toThrow()
  expect(()=>origin.verifier.take({}, {} as never)).toThrow()
  const agent = createAgent(ctx, { session: document.view, sessionId: id, factOwner: document, tools: pair.registry,
    modelCallOrigin: binding,
    model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl }), systemPrompt: 's',
    generationFactory: (action, dependencies) => createGenerationLifecycle(document.view, id, action, undefined, dependencies),
  })
  expect(()=>consumeAgentModelOrigin(binding,document.view,document,pair.registry)).toThrow()
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const outer = createToolRegistry(ctx, { executionOwner: { view: document.view, factOwner: document, context: ctx, sessionId: id } })
  const gate = Promise.withResolvers<void>()
  let continuation!: Promise<unknown>
  outer.register({ name: 'workflow', description: 'detached scheduling context', inputSchema: {}, async execute() {
    continuation = gate.promise.then(async () => {
      const run = agent.run('Use the original Code once', controller.signal)
      if (interference === 'stop') await expect(run).rejects.toThrow()
      else if (interference === 'identity') await expect(run).rejects.toThrow('Prepared exec identity changed')
      else await run
      const manual = await pair.registry.prepare({ name: 'code_exec', args: {} }, undefined, { session: document.view, sessionId: id, settlementSource: source })
      await pair.registry.dispatch(manual)
    })
    return 'yielded'
  } })
  try {
    const prepared = await outer.prepare({ name: 'workflow', args: {} }, undefined, { session: document.view, sessionId: id, settlementSource: source })
    await outer.dispatch(prepared)
    gate.resolve()
    await continuation
    expect(server.requests).toHaveLength(interference === 'stop' || interference === 'identity' ? 1 : 2)
    expect(origins).toEqual(interference === 'stop' || interference === 'identity' ? [false] : [false, false])
    const accepted = document.view.events.find(event => event.type === 'context/action' && event.op === 'close' && event.disposition === 'accepted')
    expect(accepted).toBeDefined()
    expect(observedProofs).toHaveLength(1)
    for(const {proof,expected} of observedProofs) expect(()=>origin.verifier.take(proof,expected)).toThrow()
  } finally {
    gate.resolve()
    await continuation?.catch(() => {})
    await source.close(); action.finish()
    await coordinator.close(); await server.close(); await ctx.scope.unmount()
  }
})
