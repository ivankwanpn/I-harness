import { expect, it, vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, type ToolDispatchMetadata } from '@i-harness/core-tools'
import { createTimeoutGuard } from '@i-harness/guard-timeout'
import { createRetryGuard } from '../src/index.ts'

it('settles the original timeout immediately when Stop interrupts the retry delay', async () => {
  vi.useFakeTimers()
  const ctx = createContext(), registry = createToolRegistry(ctx), upstream = new AbortController()
  const entered = Promise.withResolvers<void>()
  let attempts = 0
  ctx.mount(createRetryGuard(ctx,{maxRetries:1,initialDelayMs:60000,maxDelayMs:60000,jitterRatio:0}))
  ctx.mount(createTimeoutGuard(ctx))
  registry.register({name:'read',description:'',inputSchema:{},timeoutMs:10,isReadOnly:true,async execute(_args,exec){
    attempts++;entered.resolve()
    await new Promise<void>(resolve=>exec.abortSignal!.addEventListener('abort',()=>resolve(),{once:true}))
  }})
  try {
    let result:unknown
    const run=registry.execute({name:'read',args:{}},{signal:upstream.signal}).then(value=>{result=value.output})
    await entered.promise
    await vi.advanceTimersByTimeAsync(10)
    expect(vi.getTimerCount()).toBe(1)
    upstream.abort(new Error('original Stop'))
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toMatchObject({code:'TOOL_TIMEOUT'})
    expect(attempts).toBe(1);expect(vi.getTimerCount()).toBe(0)
    await run
  } finally {vi.clearAllTimers();vi.useRealTimers();await ctx.scope.unmount()}
})

it.each(['write-timeout', 'user-data'] as const)('does not replay a completed effect or trust a payload-shaped timeout: %s', async mode => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  const attempts: number[] = []
  registry.register({ name: 'fixture', description: '', inputSchema: {}, isConcurrencySafe: true,
    isReadOnly: mode === 'user-data', timeoutMs: 20, async execute(_args, exec) {
      attempts.push(1)
      if (mode === 'write-timeout') await new Promise<void>(resolve => exec.abortSignal!.addEventListener('abort', () => resolve(), { once:true }))
      return {code:'TOOL_TIMEOUT', fixture:'ordinary data'}
    } })
  ctx.mount(createRetryGuard(ctx, {maxRetries:1,initialDelayMs:1,maxDelayMs:1,jitterRatio:0}))
  ctx.mount(createTimeoutGuard(ctx))
  try {
    expect((await registry.execute({name:'fixture',args:{}})).output).toMatchObject({code:'TOOL_TIMEOUT'})
    expect(attempts).toHaveLength(1)
  } finally { await ctx.scope.unmount() }
})

it('refuses late first body entry when an inner hook resumes after the real timeout reply', async () => {
  const ctx=createContext(), registry=createToolRegistry(ctx), release=Promise.withResolvers<void>(), late=Promise.withResolvers<unknown>()
  ctx.mount(createTimeoutGuard(ctx))
  ctx.onCascade('tools/execute',async (_dispatch,next)=>{
    await release.promise
    try { const value=await next(); late.resolve(value); return value }
    catch(error) { late.resolve(error); throw error }
  })
  let effects = 0
  registry.register({name:'write',description:'',inputSchema:{},timeoutMs:15,async execute(){effects++;return 'done'}})
  try {
    expect((await registry.execute({name:'write',args:{}})).output).toMatchObject({code:'TOOL_TIMEOUT'})
    release.resolve()
    await expect(late.promise).resolves.toMatchObject({code:'TOOL_TIMEOUT'})
    expect(effects).toBe(0)
  } finally { release.resolve(); await ctx.scope.unmount() }
})

it('never reuses another dispatch timeout as retry evidence, even when the output object is identical', async () => {
  const ctx=createContext(), registry=createToolRegistry(ctx)
  let genuine: unknown, reads=0
  ctx.onCascade('tools/execute', async (input,next)=>{
    const result=await next()
    if ((input as ToolDispatchMetadata).name === 'original') genuine=result
    return result
  })
  ctx.mount(createRetryGuard(ctx,{maxRetries:1,initialDelayMs:1,maxDelayMs:1,jitterRatio:0}))
  ctx.mount(createTimeoutGuard(ctx))
  registry.register({name:'original',description:'',inputSchema:{},timeoutMs:15,async execute(_args,exec){
    await new Promise<void>(resolve=>exec.abortSignal!.addEventListener('abort',()=>resolve(),{once:true}))
  }})
  registry.register({name:'reader',description:'',inputSchema:{},isReadOnly:true,async execute(){reads++;return genuine}})
  try {
    await registry.execute({name:'original',args:{}})
    expect(genuine).toMatchObject({code:'TOOL_TIMEOUT'})
    expect((await registry.execute({name:'reader',args:{}})).output).toEqual(genuine)
    expect(reads).toBe(1)
  } finally { await ctx.scope.unmount() }
})

it('refuses a retained retry callback after its original dispatch returned', async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  let metadata: ToolDispatchMetadata | undefined, calls = 0
  ctx.onCascade('tools/execute', async (input, next) => { metadata = input as ToolDispatchMetadata; return next() })
  registry.register({ name: 'control', description: '', inputSchema: {}, async execute() { return ++calls } })
  try {
    expect((await registry.execute({ name: 'control', args: {} })).output).toBe(1)
    await expect(metadata!.retryAttempt!()).rejects.toThrow(/dispatch.*closed/i)
    expect(calls).toBe(1)
  } finally { await ctx.scope.unmount() }
})

it('joins concurrent retries inside one still-open dispatch', async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let metadata: ToolDispatchMetadata | undefined, calls = 0, frames = 0
  ctx.onCascade('tools/execute', async (input, next) => {
    metadata = input as ToolDispatchMetadata
    const first = ++frames === 1, result = await next()
    if (first) { entered.resolve(); await release.promise }
    return result
  })
  registry.register({ name: 'control', description: '', inputSchema: {}, isReadOnly: true, async execute() { return ++calls } })
  const run = registry.execute({ name: 'control', args: {} })
  try {
    await entered.promise
    const first = metadata!.retryAttempt!(), second = metadata!.retryAttempt!()
    expect(first).toBe(second)
    expect(await first).toEqual({ kind: 'result', value: 2 })
    expect(await second).toEqual({ kind: 'result', value: 2 })
    expect(calls).toBe(2)
  } finally { release.resolve(); await run; await ctx.scope.unmount() }
})

it('keeps a still-running timed-out producer single without starting another effect', async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  const release = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>()
  let calls = 0
  registry.register({ name: 'control', description: '', inputSchema: {}, isReadOnly: true, timeoutMs: 10, async execute() { calls++; await release.promise; completed.resolve(); return 'late' } })
  ctx.mount(createRetryGuard(ctx, { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }))
  ctx.mount(createTimeoutGuard(ctx))
  try {
    expect((await registry.execute({ name: 'control', args: {} })).output).toMatchObject({ code: 'TOOL_TIMEOUT' })
    expect(calls).toBe(1)
  } finally { release.resolve(); await completed.promise; await ctx.scope.unmount() }
})

it('rechecks current policy before a retry body after backoff', async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  let denied = false, calls = 0
  ctx.guard('tools/execute', () => denied ? 'revoked during first attempt' : undefined)
  registry.register({ name: 'control', description: '', inputSchema: {}, isReadOnly: true, timeoutMs: 10, async execute(_args, exec) {
    calls++
    await new Promise<void>(resolve => exec.abortSignal!.addEventListener('abort', () => { denied = true; resolve() }, { once: true }))
    return 'cancelled'
  } })
  ctx.mount(createRetryGuard(ctx, { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }))
  ctx.mount(createTimeoutGuard(ctx))
  try {
    await expect(registry.execute({ name: 'control', args: {} })).rejects.toThrow(/guard denied.*revoked/)
    expect(calls).toBe(1)
  } finally { await ctx.scope.unmount() }
})

it('keeps one approval capture and final result around distinct attempts', async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  let calls = 0, approvals = 0, pre = 0, post = 0
  ctx.on('tools/pre-execute', () => { pre++; return { kind: 'ask', reason: 'approve original call' } })
  ctx.services.register('approval/prepared', () => { approvals++; return { remembered: true, remember: { available: true }, validate: () => true } })
  ctx.on('tools/post-execute', () => { post++ })
  registry.register({ name: 'control', description: '', inputSchema: {}, isReadOnly: true, timeoutMs: 10, async execute(_args, exec) {
    if (++calls === 1) await new Promise<void>(resolve => exec.abortSignal!.addEventListener('abort', () => resolve(), { once: true }))
    return calls
  } })
  ctx.mount(createRetryGuard(ctx, { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }))
  ctx.mount(createTimeoutGuard(ctx))
  try {
    expect((await registry.execute({ name: 'control', args: {} })).output).toBe(2)
    expect({ calls, approvals, pre, post }).toEqual({ calls: 2, approvals: 1, pre: 1, post: 1 })
  } finally { await ctx.scope.unmount() }
})
