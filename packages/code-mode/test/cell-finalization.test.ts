import { expect, it, vi } from 'vitest'
import { Worker } from 'node:worker_threads'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSession, createNondurableFactOwner } from '@i-harness/core-session'
import { createCodeModeBroker } from '../src/broker.ts'
import { createCodeModeRuntime } from '../src/runtime.ts'
import { registerCodeMode } from '../src/register.ts'
import { captureOriginalCellFinalization, observeOriginalCellFinalizations, type OriginalCellFinalization } from '../src/finalization.ts'

it('retains the ordinary original broker cell until its accepted nested invocation actually drains', async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const started = Promise.withResolvers<void>(), body = Promise.withResolvers<string>()
  tools.register({ name: 'held', description: '', inputSchema: {}, execute: async () => { started.resolve(); return body.promise } })
  const broker = createCodeModeBroker(ctx, tools, { session })
  broker.startCell('ordinary')
  const invocation = broker.invoke({ cellId: 'ordinary', invocationId: 'original-call', name: 'held', args: {}, origin: {}, signal: new AbortController().signal })
  void invocation.catch(() => {})
  try {
    await started.promise
    broker.retireCell('ordinary')
    let done = false
    const finish = broker.finishRetiredCell('ordinary').then(() => { done = true })
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false)
    expect(() => broker.startCell('ordinary')).toThrow()
    body.resolve('original value'); await invocation; await finish
    expect(done).toBe(true)
    await broker.finishRetiredCell('ordinary')
  } finally { body.resolve('cleanup'); await invocation.catch(() => {}); await broker.finishRetiredCell('ordinary'); await broker.dispose() }
})

it('captures the original runtime join before effects and preserves prompt ordinary completion through observer retirement', async () => {
  const body = Promise.withResolvers<unknown>(), started = Promise.withResolvers<void>()
  let handle: OriginalCellFinalization | undefined, id = '', capturedBeforeEffect = false
  const runtime = createCodeModeRuntime({ tools: () => [{ name: 'held', description: '', inputSchema: {} }],
    invoke: async () => { capturedBeforeEffect = !!handle; started.resolve(); return body.promise } })
  const off = observeOriginalCellFinalizations(runtime, (cell, original) => { id = cell; handle = original })
  try {
    const out = await runtime.exec({ code: 'tools.held({}); text("done")', yield_time_ms: 60000 })
    await started.promise
    expect(out).toMatchObject({ status: 'completed', text: 'done' })
    expect(capturedBeforeEffect).toBe(true)
    expect(handle!.scope).toBe('runtime-retirement')
    expect(() => captureOriginalCellFinalization({ ...runtime }, id)).toThrow()
    let settled = false
    const original = handle!.settle().then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false)
    body.resolve('late original'); await original
    await handle!.settle()
    expect(() => captureOriginalCellFinalization(runtime, id)).toThrow()
  } finally { off(); body.resolve('cleanup'); await runtime.dispose() }
})

it('joins only the captured mount cell and keeps an unrelated original producer live', async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const held = Promise.withResolvers<unknown>(), started = Promise.withResolvers<void>()
  let aborted = false
  tools.register({ name: 'held', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async (_args, exec) => {
    exec.abortSignal?.addEventListener('abort', () => { aborted = true }); started.resolve(); return held.promise
  } })
  tools.register({ name: 'background_result', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async () => ({ job_id: 'intentional-background' }) })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: 'mixed' } })
  const handles: OriginalCellFinalization[] = []
  const off = observeOriginalCellFinalizations(mount, (_id, handle) => { handles.push(handle) })
  try {
    const first = await tools.get('code_exec')!.execute({ code: 'tools.held({}); text("first")', yield_time_ms: 60000 }, { session })
    await started.promise
    expect(first).toMatchObject({ status: 'completed', text: 'first' })
    expect(aborted).toBe(true)
    let firstJoined = false
    const firstJoin = handles[0]!.settle().then(() => { firstJoined = true })
    const second = await tools.get('code_exec')!.execute({ code: 'text(await tools.background_result({}))', yield_time_ms: 60000 }, { session })
    expect(second).toMatchObject({ status: 'completed' })
    await handles[1]!.settle()
    expect(handles[1]!.scope).toBe('cell-finalization')
    expect(firstJoined).toBe(false)
    held.resolve('original reply'); await firstJoin
    expect(session.events.filter(event => event.type === 'code/result')).toHaveLength(2)
  } finally { off(); held.resolve('cleanup'); await mount.dispose() }
})

it('retains a raw falsey original worker termination failure without retrying or rewriting the program', async () => {
  const real = Worker.prototype.terminate
  const terminate = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
    // The actual original worker is stopped; inject loss of its successful reply.
    return real.call(this).then(() => Promise.reject(null))
  })
  const runtime = createCodeModeRuntime({ tools: () => [], invoke: async () => undefined })
  let handle!: OriginalCellFinalization
  const off = observeOriginalCellFinalizations(runtime, (_id, original) => { handle = original })
  try {
    expect(await runtime.exec({ code: 'text("program value")', yield_time_ms: 60000 })).toMatchObject({ status: 'completed', text: 'program value' })
    await expect(handle.settle()).rejects.toBe(null)
    await expect(handle.settle()).rejects.toBe(null)
    expect(terminate).toHaveBeenCalledTimes(1)
    await expect(runtime.dispose()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  } finally { off(); terminate.mockRestore() }
})

it('does not acknowledge mount finalization before the original nondurable terminal flush', async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const entered = Promise.withResolvers<void>(), flush = Promise.withResolvers<void>()
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: 'mixed' }, flush: () => { entered.resolve(); return flush.promise } })
  let handle!: OriginalCellFinalization
  const off = observeOriginalCellFinalizations(mount, (_id, original) => { handle = original })
  try {
    const result = tools.get('code_exec')!.execute({ code: 'text("value")', yield_time_ms: 60000 }, { session })
    await entered.promise
    let joined = false
    const finalization = handle.settle().then(() => { joined = true })
    await Promise.resolve(); await Promise.resolve(); expect(joined).toBe(false)
    flush.resolve(); expect(await result).toMatchObject({ status: 'completed', text: 'value' })
    await finalization; expect(joined).toBe(true)
  } finally { off(); flush.resolve(); await mount.dispose() }
})

it('retains the original source-close acknowledgment after its program reply and retries falsey debt without replay', async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession(), owner = createNondurableFactOwner(session)
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let failed = true, bodies = 0, drains = 0
  const originalBegin = owner.beginAction.bind(owner)
  vi.spyOn(owner, 'beginAction').mockImplementation((...args) => {
    const action = originalBegin(...args), originalRegister = action.registerSettlementSource.bind(action)
    vi.spyOn(action, 'registerSettlementSource').mockImplementation((drain, reconcile, checkpoint) => originalRegister(async () => {
      await drain(); drains++; entered.resolve(); await gate.promise
      if (failed) throw false
    }, reconcile, checkpoint))
    return action
  })
  tools.register({ name: 'value', description: '', inputSchema: {}, execute: async () => { bodies++; return 'original value' } })
  const broker = createCodeModeBroker(ctx, tools, { session, factOwner: owner })
  const original = broker.startCell('source-owner')
  try {
    expect(await broker.invoke({ cellId: 'source-owner', invocationId: 'same-call', name: 'value', args: {}, origin: {}, signal: new AbortController().signal })).toBe('original value')
    await entered.promise
    broker.retireCell('source-owner')
    let joined = false
    const pending = original.settle().then(() => { joined = true })
    void pending.catch(() => {})
    await Promise.resolve(); await Promise.resolve(); expect(joined).toBe(false)
    gate.resolve(); await expect(pending).rejects.toBe(false)
    expect(() => broker.startCell('source-owner')).toThrow()
    failed = false; await original.settle(); await original.settle()
    expect(bodies).toBe(1); expect(drains).toBe(2)
    expect(session.events.filter(event => event.type === 'code/result')).toHaveLength(1)
  } finally { failed = false; gate.resolve(); await broker.dispose(); vi.restoreAllMocks() }
})
