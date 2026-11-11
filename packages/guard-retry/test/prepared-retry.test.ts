import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, type ToolDispatchMetadata } from '@i-harness/core-tools'
import { createTimeoutGuard } from '@i-harness/guard-timeout'
import { createRetryGuard } from '../src/index.ts'

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
  registry.register({ name: 'control', description: '', inputSchema: {}, async execute() { return ++calls } })
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
  registry.register({ name: 'control', description: '', inputSchema: {}, timeoutMs: 10, async execute() { calls++; await release.promise; completed.resolve(); return 'late' } })
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
  registry.register({ name: 'control', description: '', inputSchema: {}, timeoutMs: 10, async execute(_args, exec) {
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
  registry.register({ name: 'control', description: '', inputSchema: {}, timeoutMs: 10, async execute(_args, exec) {
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
