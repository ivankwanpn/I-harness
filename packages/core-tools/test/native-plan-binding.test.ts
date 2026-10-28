import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, nativeMutation, nativeOperation, nativePlanValidationFailure, isNativePlanValidationError } from '../src/index.ts'

it('does not execute after its native plan provider changes during an execution hook', async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  let release!: () => void, entered!: () => void, effects = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const arrived = new Promise<void>(resolve => { entered = resolve })
  const tool = { name: 'native', description: '', inputSchema: {}, captureNativePlan: () => ({ targets: [], operation: {} }), execute: async () => { effects++; return 'done' } }
  registry.register(tool)
  const prepared = await registry.prepare({ name: 'native', args: {} })
  ctx.onCascade('tools/execute', async (_input, next) => { entered(); await gate; return next() })
  const dispatch = registry.dispatch(prepared)
  await arrived
  tool.captureNativePlan = () => ({ targets: [], operation: { changed: true } })
  release()
  await expect(dispatch).rejects.toThrow(/binding|replaced|revoked/i)
  expect(effects).toBe(0)
})

it('captures one plan with the original receiver and exposes the same frozen operation to the body', async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  const observed: unknown[] = []
  const tool = { name: 'planned', description: '', inputSchema: {},
    captureNativePlan(args: unknown) { observed.push(this, args, Object.isFrozen(args)); return { targets: [], operation: { args } } },
    execute: async (args: unknown, exec: import('../src/types.ts').ToolExec) => { observed.push(args, nativeOperation(exec)); return 'done' },
  }
  registry.register(tool)
  const args = { value: 'original' }, capture = registry.capture({ name: tool.name, args })
  const inspected = registry.inspectCapture(capture)
  args.value = 'changed'
  const prepared = await registry.prepareCaptured(capture)
  await registry.dispatch(prepared)
  expect(observed).toEqual([tool, { value: 'original' }, true, { value: 'original' }, inspected.native!.operation])
  expect(observed[4]).toBe(inspected.native!.operation)
  expect(Object.isFrozen(inspected.native!.operation)).toBe(true)
})

it('rejects copied, foreign, reused, and replaced captures before execution', async () => {
  const registry = createToolRegistry(createContext()), other = createToolRegistry(createContext())
  let effects = 0
  const tool = { name: 'x', description: '', inputSchema: {}, execute: async () => { effects++; return 'done' } }
  registry.register(tool)
  const captured = registry.capture({ name: 'x', args: {} })
  expect(() => registry.inspectCapture({ ...captured })).toThrow(/foreign/i)
  expect(() => other.inspectCapture(captured)).toThrow(/foreign/i)
  await registry.prepareCaptured(captured)
  await expect(registry.prepareCaptured(captured)).rejects.toThrow(/already/i)
  const replaced = registry.capture({ name: 'x', args: {} })
  registry.unregister('x'); registry.register(tool)
  await expect(registry.prepareCaptured(replaced)).rejects.toThrow(/binding/i)
  expect(effects).toBe(0)
})

it('preserves nominal expected failures while arbitrary coded failures remain unexpected', () => {
  const expected = nativePlanValidationFailure({ error: 'bad patch', code: 'BAD_PATCH' })
  expect(isNativePlanValidationError(expected)).toBe(true)
  expect(Object.isFrozen(expected.output)).toBe(true)
  expect(isNativePlanValidationError({ code: 'BAD_PATCH', error: 'bad patch' })).toBe(false)
  const registry = createToolRegistry(createContext())
  registry.register({ name: 'bad', description: '', inputSchema: {}, captureNativePlan() { throw expected }, execute: async () => undefined })
  expect(() => registry.capture({ name: 'bad', args: {} })).toThrow(expected)
  registry.unregister('bad')
  const unexpected = Object.assign(new Error('unexpected'), { code: 'BAD_PATCH' })
  registry.register({ name: 'bad', description: '', inputSchema: {}, captureNativePlan() { throw unexpected }, execute: async () => undefined })
  try { registry.capture({ name: 'bad', args: {} }); throw new Error('missing failure') } catch (error) { expect(error).toBe(unexpected); expect(isNativePlanValidationError(error)).toBe(false) }
})


it('retains the captured operation while approval is pending', async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  let release!: (value: boolean) => void, arrived!: () => void, calls = 0, body: unknown
  const gate = new Promise<boolean>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { arrived = resolve })
  ctx.waterfall('tools/pre-execute', async (payload, next) => { await next(payload); return { kind: 'ask', reason: 'confirm' } })
  ctx.services.register('approval/answerer', async () => { arrived(); return gate })
  registry.register({ name: 'approval', description: '', inputSchema: {},
    captureNativePlan(args) { calls++; return { targets: [], operation: { args } } },
    execute: async (args, exec) => { body = [args, nativeOperation(exec)]; return 'done' },
  })
  const args = { value: 'original' }, capture = registry.capture({ name: 'approval', args })
  const plan = registry.inspectCapture(capture).native!
  const pending = registry.prepareCaptured(capture)
  await entered; args.value = 'changed'; release(true)
  await registry.dispatch(await pending)
  expect(calls).toBe(1)
  expect(body).toEqual([{ value: 'original' }, { args: { value: 'original' } }])
  expect((body as unknown[])[1]).toBe(plan.operation)
})

it('checks captured targets and invokes the bound mutation callback with its original receiver', async () => {
  const registry = createToolRegistry(createContext()), path = 'C:/project/file.txt'
  const events: unknown[] = [], authority = {
    assertCurrent() { events.push(this, 'assert') },
    before(boundary: unknown) { events.push(this, boundary) },
    settle() { events.push(this, 'settle') },
  }
  registry.register({ name: 'write', description: '', inputSchema: {},
    captureNativePlan: () => ({ targets: [{ path, kind: 'file', mode: 'mutate' }], operation: {} }),
    execute: async (_args, exec) => { const mutation = nativeMutation(exec); mutation.before({ target: path, operation: 'write' }); expect(() => mutation.before({ target: 'C:/other', operation: 'write' })).toThrow(/outside/); mutation.settle(); return 'done' },
  })
  const capture = registry.capture({ name: 'write', args: {} }), origin = { kind: 'accepted-instruction-call' as const }
  registry.bindNativeInstructions(capture, origin, authority)
  const prepared = await registry.prepareCaptured(capture, undefined, origin)
  await registry.dispatch(prepared)
  expect(events).toEqual([authority, 'assert', authority, { target: path, operation: 'write' }, authority, 'settle'])
})
