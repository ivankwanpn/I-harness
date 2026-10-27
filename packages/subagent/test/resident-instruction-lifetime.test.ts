import { expect, it, vi } from 'vitest'
const observations = vi.hoisted(() => ({ executions: [] as NonNullable<ReturnType<typeof import('../src/followup/generation.ts').beginFollowupExecution>>[] }))
vi.mock('../src/followup/generation.ts', async original => {
  const native = await original<typeof import('../src/followup/generation.ts')>()
  return { ...native, beginFollowupExecution(...args: Parameters<typeof native.beginFollowupExecution>) {
    const execution = native.beginFollowupExecution(...args)
    if (execution) observations.executions.push(execution)
    return execution
  } }
})
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSession } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { registerExec } from '@i-harness/exec'
import { createMockClient } from '@i-harness/llm-mock'
import { registerSubagent, driveFollowups, type ChildAgentEntry } from '../src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import type { AgentGenerationLifecycle } from '@i-harness/core-agent'
import type { ManagedAction, ProducerFactOutcome } from '@i-harness/core-session'
import { createResultCapture } from '../../output-retention/src/index.ts'

async function harness(control: {
  lifecycle?(value: AgentGenerationLifecycle): AgentGenerationLifecycle
  action?(value: ManagedAction<ProducerFactOutcome>): void
  mount?: import('@i-harness/code-mode').CodeModeFactory
  resident?: boolean
  results?: import('../src/task/result.ts').TaskResultStore
} = {}) {
  observations.executions = []
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'own-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' }); await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent' })
  const parent = await coordinator.openManagedDocument('parent'), document = await coordinator.openManagedDocument('child')
  await document.delivery.record({ type: 'subagent/inbox', messageId: 'original', message: 'original inbox', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  const begin = document.beginAction.bind(document)
  document.beginAction = (...args) => { const action = begin(...args); control.action?.(action); return action }
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const unmounted: import('@i-harness/core-plugin').PluginContext[] = [], mount = ctx.scope.mount.bind(ctx.scope)
  ctx.scope.mount = (...args) => { const child = mount(...args), unmount = child.scope.unmount.bind(child.scope)
    child.scope.unmount = (...unmountArgs) => { unmounted.push(child); return unmount(...unmountArgs) }; return child }
  tools.register({ name: 'read', description: 'fixture read', inputSchema: {}, execute: async () => ({}) })
  const sub = registerSubagent(ctx, tools, { parentSession: parent.view, factOwner: parent, parentModel: createMockClient([]), resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), exec: registerExec(ctx),
    results: control.results,
    persist: { coordinator, stateId: 'parent', parentSessionId: 'parent' }, codeModeFactory: control.mount,
    generationFactoryFor: (owner, id) => action => {
      const lifecycle = createGenerationLifecycle(owner.view, id, action, { enabled: true, selectedClient: () => undefined })
      return control.lifecycle?.(lifecycle) ?? lifecycle
    } })
  await sub.ready
  sub.roles.register({ name: 'fixture', description: 'owned fixture', systemPrompt: 'fixture', tools: control.mount ? ['read'] : [] })
  const entry: ChildAgentEntry = { path: 'root/helper', sessionId: 'child', session: document.view, factOwner: document, roleName: 'fixture', status: 'waiting', mailbox: [], controller: new AbortController(), lastInboxSeq: -1 }
  sub.table.add(entry.path, entry)
  if (!control.resident) sub.agents.register('child', { run: async () => { throw Error('No initial run') }, followup: async () => ({ finalText: 'done', turns: 1, reasoning: [] }) })
  return { root, sub, entry, document, ctx, coordinator, unmounted,
    drive: () => driveFollowups({ agents: sub.agents, table: sub.table, jobs: sub.jobs, results: control.results, openGeneration: sub.followupGeneration, captureGeneration: sub.captureFollowupGeneration,
      ...(control.resident ? { rebuild: (entry, controller, current) => sub.ensureResident(entry, controller, current) } : {}) }, entry, 'child'),
    async close() { await sub.dispose(); await coordinator.close(); await ctx.scope.unmount() } }
}

// A failed original close must not drain/finish its dependencies, and the
// register owner must retry that exact close despite the caught drive chain.
it.each(['generation', 'drain', 'finish'].flatMap(phase => [undefined, null, false, 0, ''].map(failure => ({ phase, failure }))))('retains failed $phase with $failure and retries only remaining original phases', async ({ phase, failure }) => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'rl-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'child', origin: 'subagent', parentSession: 'parent' })
  const document = await coordinator.openManagedDocument('child')
  await document.delivery.record({ type: 'subagent/inbox', messageId: 'inbox', message: 'original', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let closes = 0, drains = 0, finishes = 0, fail = true
  const begin = document.beginAction.bind(document)
  vi.spyOn(document, 'beginAction').mockImplementation((...args) => { const action = begin(...args), finish = action.finish.bind(action); action.finish = () => { finishes++; if (phase === 'finish' && fail) throw failure; return finish() }; return action })
  const sub = registerSubagent(ctx, tools, { parentSession: createSession(), parentModel: createMockClient([]), resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), exec: registerExec(ctx),
    generationFactoryFor: (owner, id) => action => {
      const lifecycle = createGenerationLifecycle(owner.view, id, action, { enabled: true, selectedClient: () => undefined })
      return { ...lifecycle, async drain() { drains++; if (phase === 'drain' && fail) throw failure; await lifecycle.drain() }, async open(...args) {
        const generation = await lifecycle.open(...args), close = generation.close.bind(generation)
        generation.close = async (...closeArgs) => { closes++; if (phase === 'generation' && fail) throw failure; await close(...closeArgs) }
        return generation
      } }
    } })
  const entry: ChildAgentEntry = { path: 'root/helper', sessionId: 'child', session: document.view, factOwner: document, status: 'waiting', mailbox: [], controller: new AbortController(), lastInboxSeq: -1 }
  sub.table.add(entry.path, entry)
  sub.agents.register('child', { run: async () => { throw Error('no initial run') }, followup: async () => ({ finalText: 'done', turns: 1, reasoning: [] }) })
  const driving = driveFollowups({ agents: sub.agents, table: sub.table, jobs: sub.jobs, openGeneration: sub.followupGeneration, captureGeneration: sub.captureFollowupGeneration }, entry, 'child')
  try {
    const observed = await driving.then(() => ({ occurred: false }), value => ({ occurred: true, value }))
    expect(entry.error).toBeUndefined()
    expect(observed).toEqual({ occurred: true, value: failure })
    expect([closes, drains, finishes]).toEqual(phase === 'generation' ? [1, 0, 0] : phase === 'drain' ? [1, 1, 0] : [1, 1, 1])
    fail = false
    await sub.dispose()
    expect([closes, drains, finishes]).toEqual(phase === 'generation' ? [2, 1, 1] : phase === 'drain' ? [1, 2, 1] : [1, 1, 2])
    await sub.dispose()
    expect([closes, drains, finishes]).toEqual(phase === 'generation' ? [2, 1, 1] : phase === 'drain' ? [1, 2, 1] : [1, 1, 2])
  } finally { fail = false; await sub.dispose().catch(() => {}); await coordinator.close(); await ctx.scope.unmount() }
})

it('signals body exit before its held original close and shares that cleanup with concurrent external dispose', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let closes = 0, drains = 0, finishes = 0
  let ownerIdentity: unknown
  const f = await harness({ action(action) { ownerIdentity = Object.getOwnPropertyDescriptor(action, 'owner')?.value; const finish = action.finish.bind(action); action.finish = () => { finishes++; finish() } }, lifecycle(lifecycle) {
    const open = lifecycle.open.bind(lifecycle), drain = lifecycle.drain.bind(lifecycle)
    lifecycle.open = async (...args) => { const generation = await open(...args), close = generation.close.bind(generation)
      generation.close = async (...closeArgs) => { closes++; entered.resolve(); await release.promise; await close(...closeArgs) }; return generation }
    lifecycle.drain = async () => { drains++; await drain() }; return lifecycle
  } })
  const driving = f.drive(); let rawDone = false
  void driving.then(() => { rawDone = true })
  try {
    await entered.promise
    const execution = observations.executions[0]!
    expect(execution.rawNext).toBe(driving)
    await execution.bodyExit.promise
    expect(rawDone).toBe(false)
    const closing = f.sub.dispose(); let disposed = false
    void closing.then(() => { disposed = true })
    await Promise.resolve()
    expect([closes, drains, finishes]).toEqual([1, 0, 0]); expect(disposed).toBe(false)
    release.resolve(); await driving; await closing
    expect(rawDone).toBe(true); expect([closes, drains, finishes]).toEqual([1, 1, 1])
    await execution.rawNext
    console.info('resident-original-cleanup-evidence', JSON.stringify({ root: f.root, owner: ownerIdentity,
      inbox: { seq: execution.input.seq, messageId: execution.input.messageId }, intent: execution.intent,
      generations: f.document.view.events.filter(e => e.type === 'context/action' && (e.op === 'open' || e.op === 'close')),
      sameRawNext: execution.rawNext === driving, bodyExited: true, rawDone, originalPhaseCounts: { closes, drains, finishes } }))
  } finally { release.resolve(); await driving.catch(() => {}); await f.close() }
})

it.each([undefined, null, false, 0, ''])('keeps partial-open primary %s distinct from original drain failure and retries that same lifecycle', async primary => {
  const cleanup = new Error('original drain debt')
  let opens = 0, drains = 0, finishes = 0, fail = true
  const f = await harness({ action(action) { const finish = action.finish.bind(action); action.finish = () => { finishes++; finish() } }, lifecycle(lifecycle) {
    const drain = lifecycle.drain.bind(lifecycle)
    lifecycle.open = async () => { opens++; throw primary }
    lifecycle.drain = async () => { drains++; if (fail) throw cleanup; await drain() }
    return lifecycle
  } })
  try {
    const result = await f.drive().then(() => undefined, error => error)
    expect(result).toBeInstanceOf(AggregateError)
    expect(result.cause).toBe(primary); expect(result.errors).toEqual([primary, cleanup])
    expect([opens, drains, finishes]).toEqual([1, 1, 0])
    await observations.executions[0]!.bodyExit.promise
    fail = false; await f.sub.dispose()
    expect([opens, drains, finishes]).toEqual([1, 2, 1])
  } finally { fail = false; await f.close() }
})

it.each([undefined, null, false, 0, ''])('retains setup primary %s, exact mount and context through independent dispose failure', async primary => {
  const cleanup = new Error('original mount remains held')
  let ready = 0, cancels = 0, disposes = 0, fail = true
  let childCtx: import('@i-harness/core-plugin').PluginContext | undefined
  const f = await harness({ resident: true, mount(ctx) {
    childCtx = ctx
    return { schemas: () => [], async ready() { ready++; throw primary }, async cancel() { cancels++ }, async dispose() { disposes++; if (fail) throw cleanup } }
  } })
  const closeDocument = vi.spyOn(f.document, 'close')
  try {
    const driving = f.drive()
    await expect.poll(() => childCtx).toBeDefined()
    const result = await driving.then(() => undefined, error => error)
    expect(result).toBeInstanceOf(AggregateError); expect(result.cause).toBe(primary)
    expect([ready, cancels, disposes]).toEqual([1, 1, 1])
    expect(f.unmounted).not.toContain(childCtx); expect(closeDocument).not.toHaveBeenCalled()
    expect(f.sub.agents.get('child')).toBeUndefined()
    await expect(f.sub.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect([ready, cancels, disposes]).toEqual([1, 2, 2])
    expect(f.unmounted).not.toContain(childCtx); expect(closeDocument).not.toHaveBeenCalled()
    fail = false; await f.sub.dispose()
    expect([ready, cancels, disposes]).toEqual([1, 3, 3])
    expect(f.unmounted.filter(ctx => ctx === childCtx)).toHaveLength(1); expect(closeDocument).toHaveBeenCalledTimes(1)
  } finally { fail = false; await f.close() }
})

it('retains original mount callbacks and their receiver across a failed close instead of adopting replacements', async () => {
  let fail = true, originalDisposes = 0, replacementDisposes = 0
  const mounts: import('@i-harness/code-mode').CodeModeMount[] = []
  let originalDispose: (() => Promise<void>) | undefined
  const f = await harness({ resident: true, mount() {
    const mount = { schemas: () => [], async ready() { throw new Error('original setup failed') }, async cancel() {}, async dispose() {
      expect(this).toBe(mount); originalDisposes++; if (fail) throw false
    } }
    originalDispose = mount.dispose.bind(mount)
    mounts.push(mount); return mount
  } })
  try {
    await expect(f.drive()).rejects.toBeInstanceOf(AggregateError)
    const mount = mounts[0]!
    mount.dispose = async () => { replacementDisposes++; throw new Error('replacement callback has no ownership') }
    fail = false
    await f.sub.dispose()
    expect([originalDisposes, replacementDisposes]).toEqual([2, 0])
  } finally {
    fail = false
    // Preserve the failed test's original owner for cleanup; do not leave a
    // replacement callback to poison fixture shutdown after a genuine RED.
    mounts[0]!.dispose = originalDispose!
    await f.close()
  }
})

it.each([false, true])('retains the original rejected result settlement with one cleanup attempt (removed=%s)', async removed => {
  let fail = true, captures = 0, settlements = 0, replacementSettlements = 0
  const debt = new Error('original result settlement')
  const f = await harness({ results: {
    capture(_target, body, _revision, execution) {
      captures++
      const capture = createResultCapture(body, execution!, { openArtifact: async () => { throw Error('Inline fixture has no artifact owner') } }), settle = capture.settle.bind(capture)
      capture.settle = async () => { settlements++; if (fail) throw debt; return settle() }
      return capture
    }, read: async () => { throw Error('No artifact reader') },
  } })
  try {
    await expect(f.drive()).rejects.toBe(debt)
    expect([captures, settlements]).toEqual([1, 1])
    const handle = f.entry.resultCapture!, settle = handle.settle.bind(handle)
    handle.settle = async () => { replacementSettlements++; return settle() }
    if (removed) f.sub.table.remove(f.entry.path)
    fail = false; await f.sub.dispose()
    expect([captures, settlements]).toEqual([1, 2])
    expect(replacementSettlements).toBe(0)
    await f.sub.dispose(); expect([captures, settlements]).toEqual([1, 2])
  } finally { fail = false; await f.close() }
})

it('refuses reentrant owner close from its original generation-open callback without joining that raw drive', async () => {
  let sub: import('../src/index.ts').RegisterSubagentResult | undefined
  let opens = 0, reentry: unknown
  const f = await harness({ lifecycle(lifecycle) {
    lifecycle.open = async () => {
      opens++
      reentry = await Promise.race([sub!.dispose().then(() => 'resolved', error => error), new Promise(resolve => setTimeout(() => resolve('self-wait'), 100))])
      throw false
    }; return lifecycle
  } })
  sub = f.sub
  try {
    await f.drive().catch(() => {})
    expect(reentry).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(opens).toBe(1)
  } finally { await f.close() }
}, 2000)

it('publishes monotone retirement before synchronous closing observers reenter dispose', async () => {
  const f = await harness({ resident: true })
  let callbacks = 0
  try {
    await f.drive()
    const closing: Promise<void>[] = []
    const off = f.sub.table.subscribe(change => {
      if (change.entry !== f.entry || !change.entry.closing) return
      callbacks++
      if (callbacks < 4) { const result = f.sub.dispose(); void result.catch(() => {}); closing.push(result) }
    })
    try {
      await f.sub.dispose(); await Promise.all(closing)
      expect(callbacks).toBeLessThanOrEqual(3)
    } finally { off() }
  } finally { await f.close() }
})

it('delivers a falsey readiness failure once while still closing siblings and allowing a clean retry', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'ready-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const parent = await coordinator.openManagedDocument('parent')
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const sub = registerSubagent(ctx, tools, { parentSession: parent.view, factOwner: parent, parentModel: createMockClient([]), resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), exec: registerExec(ctx), persist: { coordinator, stateId: 'parent', parentSessionId: 'parent' } })
  sub.tasks.qualifyRestoredResults = async () => { throw false }
  try {
    await expect(sub.ready).rejects.toBe(false)
    await expect(sub.dispose()).rejects.toBeInstanceOf(AggregateError)
    await sub.dispose()
  } finally { await sub.dispose().catch(() => {}); await coordinator.close(); await ctx.scope.unmount() }
})

it('refuses a registry-missing entry with an original unknown disposer without overwriting, closing or launching it', async () => {
  const f = await harness({ resident: true })
  const originalContext = f.ctx.scope.mount()
  let closes = 0
  const originalDispose = async () => { closes++; await f.document.close(); await originalContext.scope.unmount() }
  const originalUnmount = () => originalContext.scope.unmount()
  f.entry.dispose = originalDispose; f.entry.unmount = originalUnmount
  const begin = vi.spyOn(f.document, 'beginAction'), mount = vi.spyOn(f.ctx.scope, 'mount'), controller = f.entry.controller
  try {
    expect(f.sub.agents.get('child')).toBeUndefined()
    expect(await f.sub.ensureResident(f.entry, new AbortController())).toBe(false)
    expect(f.entry.dispose).toBe(originalDispose); expect(f.entry.unmount).toBe(originalUnmount)
    expect(f.entry.controller).toBe(controller); expect(f.entry.status).toBe('waiting')
    expect(begin).not.toHaveBeenCalled(); expect(mount).not.toHaveBeenCalled(); expect(closes).toBe(0)
    expect(f.sub.agents.get('child')).toBeUndefined()
    await f.sub.dispose(); expect(closes).toBe(1)
  } finally { await f.close() }
})
