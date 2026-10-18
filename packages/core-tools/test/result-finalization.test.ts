import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, isOriginalResultFinalization } from '../src/index.ts'

it('retains the original finalized value and retries only storage after an uncertain commit', async () => {
  const ctx = createContext()
  let bodies = 0, hooks = 0, captures = 0, settles = 0
  ctx.on('tools/post-execute', () => { hooks++ })
  const value = { answer: 42 }
  const envelope = { version: 1 as const, execution: { outcome: 'succeeded' as const, dispatch: 'dispatched' as const }, preview: '', media: [], retention: { kind: 'inline' as const, value, encodedBytes: 13 } }
  const retention = { capture() { captures++; return { async settle() { settles++; return settles === 1 ? { kind: 'recovery-required' as const } : { kind: 'ready' as const, envelope, program: { kind: 'value' as const, value } } } } } }
  const registry = (createToolRegistry as (ctx: ReturnType<typeof createContext>, options?: unknown) => ReturnType<typeof createToolRegistry>)(ctx, { resultRetention: retention })
  registry.register({ name: 'read', description: 'read', inputSchema: { type: 'object' }, async execute() { bodies++; return value } })
  const prepared = await registry.prepare({ name: 'read', args: {} })
  const output = await registry.dispatch(prepared)
  await expect(registry.finalize(prepared, output)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  const result = await registry.finalize(prepared, output)
  expect(result).toMatchObject({ output: value, envelope })
  expect({ bodies, hooks, captures, settles }).toEqual({ bodies: 1, hooks: 1, captures: 1, settles: 2 })
})

it('recognizes only the registry-owned original handle for its same genuine PreparedCall', async () => {
  const ctx = createContext(), value = { actual: true }
  const registry = createToolRegistry(ctx, { resultRetention: {
    capture() { return { async settle() { return { kind: 'ready' as const, envelope: { version: 1 as const, execution: { outcome: 'succeeded' as const, dispatch: 'dispatched' as const }, preview: '', media: [], retention: { kind: 'inline' as const, value, encodedBytes: 15 } }, program: { kind: 'value' as const, value } } } } },
    captureSynthetic() { throw new Error('No synthetic source in this fixture') },
  } })
  registry.register({ name: 'actual', description: '', inputSchema: {}, execute: async () => value })
  const first = await registry.prepare({ name: 'actual', args: {} }), second = await registry.prepare({ name: 'actual', args: {} })
  await registry.finalize(first, await registry.dispatch(first))
  const handle = registry.resultFinalization!(first)!
  expect(isOriginalResultFinalization(first, handle)).toBe(true)
  expect(isOriginalResultFinalization(second, handle)).toBe(false)
  expect(isOriginalResultFinalization({ ...first }, handle)).toBe(false)
  expect(isOriginalResultFinalization(first, { settle: handle.settle })).toBe(false)
  expect(isOriginalResultFinalization(first, undefined)).toBe(false)
})
