import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession, createNondurableFactOwner, type FactOwner } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent, type AgentDeps, type AgentConfig } from '../src/index.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { localTestGeneration } from './fixtures/generation.ts'
import { createMockClient } from '@i-harness/llm-mock'
import { observeModelClient } from '@i-harness/llm-seam'
import { assertSettlementRegistrationForwarding, type TestAction, type TestSource } from './helpers/settlement-registration.ts'

function instrumentInvocationAction(action: TestAction, hooks: {
  finish: () => void; registering?: () => void; beforeDrain?: () => Promise<void>
  registered?: (source: TestSource) => void; closing?: () => void; closed?: () => void
}): TestAction {
  const register = action.registerSettlementSource
  return { ...action, finish: hooks.finish, registerSettlementSource(...args) {
    hooks.registering?.()
    const [drain, reconcilePending, checkpointOwner] = args, beforeDrain = hooks.beforeDrain
    const source = beforeDrain
      ? register.call(action, async () => { await beforeDrain(); await drain() }, reconcilePending, checkpointOwner)
      : register.apply(action, args)
    hooks.registered?.(source)
    if (hooks.closing || hooks.closed) {
      const close = source.close
      source.close = async () => { hooks.closing?.(); await close.call(source); hooks.closed?.() }
    }
    return source
  } }
}

it.each(['held-drain', 'registration-failure', 'cleanup-order'] as const)('forwards the exact registration tuple through the invocation %s adapter', async mode => {
  await assertSettlementRegistrationForwarding(action => instrumentInvocationAction(action, {
    finish: action.finish.bind(action),
    ...(mode === 'held-drain' ? { beforeDrain: async () => {}, registered() {}, closed() {} } : {}),
    ...(mode === 'registration-failure' ? { registering() {} } : {}),
    ...(mode === 'cleanup-order' ? { closing() {} } : {}),
  }), { instrumentedDrain: mode === 'held-drain' })
})

it('keeps the invocation lifecycle gate before its original drain while the exact source remains held', async () => {
  const action = createNondurableFactOwner(createSession()).beginAction()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), order: string[] = []
  const wrapped = instrumentInvocationAction(action, {
    finish: action.finish.bind(action),
    async beforeDrain() { order.push('gate'); entered.resolve(); await release.promise },
    closed() { order.push('closed') },
  })
  const source = wrapped.registerSettlementSource(async () => { order.push('original drain') })
  const closing = source.close()
  try {
    await entered.promise
    expect(order).toEqual(['gate'])
    expect(() => source.assertHeld()).not.toThrow()
  } finally { release.resolve(); await closing; action.finish() }
  expect(order).toEqual(['gate', 'original drain', 'closed'])
})

const settled = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))

it.each([false, true])('uses original receiver and live host data without assigning ports (frozen=%s)', async frozen => {
  const ctx = createContext(), session = createSession(), otherSession = createSession()
  const requests: string[] = [], receivers: unknown[] = []
  let current = 'initial', callbacks = 0
  const client = (label: string) => ({ async *stream() { receivers.push(this); requests.push(label); yield { type: 'text/chunk', text: label } as const; yield { type: 'end' } as const } })
  const oldModel = client('old'), newModel = client('new')
  const deps: AgentDeps & AgentConfig = {
    session, tools: createToolRegistry(ctx), model: oldModel,
    get reasoningEffort() { receivers.push(this); return 'low' as const },
    systemPrompt() { receivers.push(this); callbacks++; return current },
  }
  if (frozen) Object.defineProperty(deps, 'model', { get() { receivers.push(this); return current === 'initial' ? oldModel : newModel }, enumerable: true })
  if (frozen) Object.freeze(deps)
  const keys = Reflect.ownKeys(deps)
  const agent = createAgent(ctx, deps)
  expect(callbacks).toBe(0)
  current = 'changed'
  if (!frozen) { deps.model = newModel; deps.session = otherSession }
  expect((await agent.run('task')).finalText).toBe('new')
  expect(receivers.every(value => value === deps || value === newModel)).toBe(true)
  expect(requests).toEqual(['new'])
  expect(session.events.some(event => event.type === 'turn/start')).toBe(true)
  expect(otherSession.events).toHaveLength(0)
  expect(Reflect.ownKeys(deps)).toEqual(keys)
  expect(deps.facts).toBeUndefined(); expect(deps.sourceFacts).toBeUndefined(); expect(deps.generationAction).toBeUndefined()
  agent.updateContext!({ budget: { contextWindow: 4000 }, maxOutputTokens: 256 })
  expect((await agent.followup('next')).finalText).toBe('new')
})

it.each(['provider', 'acceptance', 'stop', 'failed-drain', 'compact'] as const)(
  'retains the original invocation and source while held at %s', async boundary => {
    const ctx = createContext(), session = createSession(), original = createNondurableFactOwner(session)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const hold = async () => { entered.resolve(); await release.promise }
    const sources: object[] = [], actions: object[] = []
    let closed = 0, finished = 0, sends = 0, claims = 0, hooks = 0, flushes = 0
    const failure = new Error('controlled provider failure')
    const owner: FactOwner = { ...original, beginAction(signal) {
      const action = original.beginAction(signal)
      actions.push(action)
      return instrumentInvocationAction(action, {
        finish() { finished++; action.finish() },
        async beforeDrain() {
          if (actions.length === 1 && (boundary === 'failed-drain' || boundary === 'compact')) await hold()
        },
        registered(source) { sources.push(source) }, closed() { closed++ },
      })
    } }
    ctx.on('agent/pre-step', () => { hooks++ })
    ctx.on('agent/stop', async () => { if (actions.length === 1 && boundary === 'stop') await hold() })
    const agent = createAgent(ctx, {
      session, factOwner: owner, tools: createToolRegistry(ctx), systemPrompt: 'p',
      stepInputs: { claimAtStepBoundary() { claims++ } },
      flush: async () => { if (++flushes === 2 && boundary === 'acceptance') await hold() },
      model: { async *stream() {
        sends++
        if (sends === 1 && boundary === 'provider') await hold()
        if (sends === 1 && boundary === 'failed-drain') throw failure
        yield { type: 'text/chunk', text: 'accepted' } as const
        yield { type: 'end' } as const
      } },
    })
    const first = settled<unknown>(boundary === 'compact' ? agent.compact!() : agent.run('first'))
    try {
      await entered.promise
      const before = { events: [...session.events], actions: [...actions], sources: [...sources], sends, claims, hooks, flushes }
      for (const competitor of [() => agent.run('rejected'), () => agent.runAdmitted!('rejected'), () => agent.followup('rejected'), () => agent.compact!()]) {
        const rejected = await settled<unknown>(competitor())
        expect.soft(rejected.error).toMatchObject({ code: 'AGENT_BUSY' })
      }
      expect.soft({ events: [...session.events], actions, sources, sends, claims, hooks, flushes }).toEqual(before)
      expect.soft(closed).toBe(0)
      expect(() => agent.updateContext!({})).toThrow(/busy/i)
    } finally { release.resolve(); await first }
    const result = await first
    if (boundary === 'failed-drain') expect(result.error).toBe(failure)
    else expect(result.error).toBeUndefined()
    expect(finished).toBe(1); expect(closed).toBe(1)
    expect((await agent.followup('next')).finalText).toBe('accepted')
    expect(actions).toHaveLength(2); expect(sources).toHaveLength(2)
    expect(finished).toBe(2); expect(closed).toBe(2)
    expect(session.events.filter(event => event.type === 'turn/start')).toHaveLength(boundary === 'compact' ? 1 : 2)
  },
)

it.each(['factory', 'registration'] as const)('settles created resources after %s setup throws and releases busy ownership', async boundary => {
  const ctx = createContext(), session = createSession(), original = createNondurableFactOwner(session)
  const primary = new Error('setup failed'), cleanup = new Error('drain failed'), order: string[] = []
  let first = true
  const owner: FactOwner = { ...original, beginAction(signal) {
    const action = original.beginAction(signal)
    return instrumentInvocationAction(action, {
      finish() { order.push('finish'); action.finish() },
      registering() { if (first && boundary === 'registration') throw primary },
    })
  } }
  const deps: AgentDeps & AgentConfig = {
    session, factOwner: owner, tools: createToolRegistry(ctx), systemPrompt: 'p',
    model: { async *stream() { yield { type: 'end' } as const } },
    generationFactory() { return { async open() { throw new Error('unused') }, async drain() { order.push('drain'); throw cleanup } } },
    inputPreparationFactory() {
      if (boundary === 'factory') throw primary
      return { async prepare() { return undefined }, async cancelUnpromoted() {}, async close() { order.push('close') } }
    },
  }
  const agent = createAgent(ctx, deps)
  const result = await settled(agent.compact!())
  expect(result.error).toMatchObject({ cause: primary, errors: [primary, cleanup] })
  expect(order).toEqual(boundary === 'factory' ? ['drain', 'finish'] : ['close', 'drain', 'finish'])
  first = false
  // Another call enters the owner even after cleanup failed; its own resources
  // remain responsible for refusing unresolved work, not the busy lease.
  const again = await settled(agent.compact!())
  expect(again.error?.code).not.toBe('AGENT_BUSY')
  expect(order.filter(value => value === 'finish')).toHaveLength(2)
})

it('keeps two Agents over one host source on their distinct captured owners', async () => {
  const ctx = createContext(), firstSession = createSession(), secondSession = createSession()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let sends = 0
  const deps: AgentDeps & AgentConfig = {
    session: firstSession, tools: createToolRegistry(ctx), systemPrompt: 'shared host',
    model: { async *stream() {
      if (++sends === 1) { entered.resolve(); await release.promise }
      yield { type: 'text/chunk', text: 'done' } as const; yield { type: 'end' } as const
    } },
  }
  const firstAgent = createAgent(ctx, deps)
  deps.session = secondSession
  const secondAgent = createAgent(ctx, deps)
  const first = settled(firstAgent.run('first'))
  try {
    await entered.promise
    expect((await secondAgent.run('second')).finalText).toBe('done')
    expect(deps.sourceFacts).toBeUndefined(); expect(deps.registerFactSource).toBeUndefined()
  } finally { release.resolve(); await first }
  expect((await first).value?.finalText).toBe('done')
  expect(firstSession.events.filter(event => event.type === 'user/message')).toMatchObject([{ text: 'first' }])
  expect(secondSession.events.filter(event => event.type === 'user/message')).toMatchObject([{ text: 'second' }])
})

it('joins every created close after failures while retaining busy through generation drain', async () => {
  const ctx = createContext(), session = createSession(), original = createNondurableFactOwner(session)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const primary = new Error('operation'), preparationFailure = new Error('preparation'), drainFailure = new Error('drain'), finishFailure = new Error('finish')
  const order: string[] = []
  let factories = 0
  let originalAction: ReturnType<typeof original.beginAction> | undefined
  const owner: FactOwner = { ...original, beginAction(signal) {
    const action = original.beginAction(signal)
    originalAction = action
    return instrumentInvocationAction(action, {
      finish() { order.push('finish'); action.finish(); throw finishFailure },
      closing() { order.push('source') },
    })
  } }
  const agent = createAgent(ctx, {
    session, factOwner: owner, tools: createToolRegistry(ctx), model: createMockClient([]), systemPrompt: '',
    generationFactory() { factories++; return {
      async open() { throw primary },
      async drain() { order.push('drain'); entered.resolve(); await release.promise; throw drainFailure },
    } },
    inputPreparationFactory() { return { async prepare() { return undefined }, async cancelUnpromoted() {}, async close() { order.push('preparation'); throw preparationFailure } } },
  })
  const pending = settled(agent.compact!())
  try {
    await entered.promise
    expect(() => originalAction!.assertOpen()).toThrow('FACT_CANCELLED')
    await expect(agent.run('rejected')).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    expect(factories).toBe(1)
  } finally { release.resolve(); await pending }
  const errors = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(errors) : [error]
  expect(errors((await pending).error)).toEqual([primary, preparationFailure, finishFailure, drainFailure])
  // Each retry belongs to the same failed source. Setup/finish stay single-shot,
  // and the original operation and final drain errors are reported once above.
  expect(order).toEqual([
    'preparation', 'finish',
    'source', 'drain',
    'source', 'drain',
    'source', 'drain',
    'source', 'drain',
  ])
})

it('keeps the actual managed source through held acceptance and refuses new work after an unresolved owner drain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-agent-invocation-'))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let flushes = 0, factories = 0, sends = 0
  const model = observeModelClient(createMockClient([{ role: 'assistant', text: 'done' }, { role: 'assistant', text: 'done' }]), { start() { sends++ }, finish() {} })
  const factory = localTestGeneration(document, id, model)
  const agent = createAgent(ctx, {
    session: document.view, factOwner: document, sessionId: id, model, systemPrompt: '', tools: createToolRegistry(ctx),
    generationFactory(action, dependencies) { factories++; return factory(action, dependencies) },
    async flush() { if (++flushes === 2) { entered.resolve(); await release.promise } },
  })
  const first = settled(agent.run('first'))
  let unresolved: ReturnType<typeof document.beginAction> | undefined
  let retained: ReturnType<ReturnType<typeof document.beginAction>['registerSettlementSource']> | undefined
  let failDrain = true
  try {
    await Promise.race([entered.promise, first.then(result => { throw result.error ?? new Error('Acceptance hold was not reached') })])
    const before = [...document.view.events]
    await expect(agent.runAdmitted!('rejected')).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    expect(document.view.events).toEqual(before); expect(factories).toBe(1); expect(sends).toBe(1)
    release.resolve()
    expect((await first).value?.finalText).toBe('done')
    expect((await agent.followup('next')).finalText).toBe('done')
    const saved = (await backend.read(id)).events
    expect(saved.filter(event => event.type === 'agent/input/admitted')).toHaveLength(2)
    expect(saved.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(2)
    expect(saved.filter(event => event.type === 'turn/end')).toHaveLength(2)
    unresolved = document.beginAction()
    retained = unresolved.registerSettlementSource(async () => { if (failDrain) throw new Error('retained outcome') })
    retained.holdRecovery(); unresolved.finish()
    await expect(agent.followup('refused by owner')).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(factories).toBe(2); expect(sends).toBe(2)
  } finally {
    release.resolve(); await first
    failDrain = false; await retained?.close(); await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])('preserves the actual frozen action and factory dependencies through setup and cleanup (throw-first=%s)', async throwFirst => {
  const ctx = createContext(), session = createSession(), original = createNondurableFactOwner(session)
  const actions: ReturnType<typeof original.beginAction>[] = [], registers: unknown[] = []
  const owner: FactOwner = { ...original, beginAction(signal) {
    const action = original.beginAction(signal)
    actions.push(action); registers.push(action.registerSettlementSource)
    return Object.freeze(action)
  } }
  const model = createMockClient([{ role: 'assistant', text: 'done' }]), factory = localTestGeneration(owner, 'owner', model), setup = Error('original frozen factory setup failure')
  let factories = 0
  const agent = createAgent(ctx, { session, factOwner: owner, sessionId: 'owner', tools: createToolRegistry(ctx), model, systemPrompt: '', generationFactory(action, dependencies) {
    factories++
    expect(action).toBe(actions.at(-1)); expect(Object.isFrozen(action)).toBe(true)
    expect(action.registerSettlementSource).toBe(registers.at(-1))
    expect(dependencies?.beforeDrain).toBeTypeOf('function')
    if (throwFirst && factories === 1) throw setup
    return factory(action, dependencies)
  } })
  if (throwFirst) await expect(agent.run('first setup')).rejects.toBe(setup)
  expect((await agent.run('actual input')).finalText).toBe('done')
  expect(factories).toBe(throwFirst ? 2 : 1)
  actions.forEach((action, index) => {
    expect(action.registerSettlementSource).toBe(registers[index])
    expect(() => action.assertOpen()).toThrow('FACT_CANCELLED')
  })
})
