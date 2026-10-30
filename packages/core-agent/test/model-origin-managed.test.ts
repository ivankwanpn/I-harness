import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, bindPreparedShellLeaf, assertResultPrepared, type Tool } from '@i-harness/core-tools'
import { createToolRegistryWithModelOrigin } from '@i-harness/core-tools/model-origin'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createAgent } from '../src/index.ts'
import { createAgentModelOriginOwner, consumeAgentModelOrigin } from '../src/tool-batch/model-origin.ts'
import { createLoopbackProvider } from './helpers/provider-loopback.ts'

const wire = (tool: boolean) => `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'original-model-shell', function: { name: 'shell', arguments: '{}' } }] } : { content: 'done' }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`

it.each([{captureWholeBatch:false,interference:'none'},{captureWholeBatch:true,interference:'none'},{captureWholeBatch:false,interference:'stop'},{captureWholeBatch:false,interference:'twice-next'},{captureWholeBatch:false,interference:'identity'}] as const)('authenticates only the original accepted member ($captureWholeBatch / $interference) while detached work stays nested', async ({captureWholeBatch,interference}) => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'model-origin-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), origin = createAgentModelOriginOwner({ view: document.view, factOwner: document })
  const pair = createToolRegistryWithModelOrigin(ctx, { executionOwner: { view: document.view, factOwner: document, context: ctx, sessionId: id }, ...(captureWholeBatch ? { instructionsRequired: true } : {}) }, origin.verifier)
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(wire(true)) }, async response => { response.end(wire(false)) }])
  const controller = new AbortController()
  let armed = true
  ctx.onCascade('tools/execute', async (input: any, next) => {
    if (!armed || input.name !== 'shell') return next()
    armed = false
    if (interference === 'stop') controller.abort()
    if (interference === 'identity') input.exec.callId = 'foreign-member'
    const value = await next()
    if (interference === 'twice-next') return next()
    return value
  })
  const origins: boolean[] = []
  let leaf!: ReturnType<typeof bindPreparedShellLeaf>
  const shell: Tool = { name: 'shell', description: 'original source control', inputSchema: { type: 'object' }, async execute(_args, exec) {
    const claim = leaf.enter(exec)
    origins.push(!!claim)
    claim?.consume()
    return 'observed'
  } }
  leaf = bindPreparedShellLeaf(shell, shell.execute)
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
      const run = agent.run('Use the original Shell once', controller.signal)
      if (interference === 'stop') await expect(run).rejects.toThrow()
      else await run
      const manual = await pair.registry.prepare({ name: 'shell', args: {} }, undefined, { session: document.view, sessionId: id, settlementSource: source })
      await pair.registry.dispatch(manual)
    })
    return 'yielded'
  } })
  try {
    const prepared = await outer.prepare({ name: 'workflow', args: {} }, undefined, { session: document.view, sessionId: id, settlementSource: source })
    await outer.dispatch(prepared)
    gate.resolve()
    await continuation
    expect(server.requests).toHaveLength(interference === 'stop' ? 1 : 2)
    expect(origins).toEqual(interference === 'stop' || interference === 'identity' ? [false] : [true, false])
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
