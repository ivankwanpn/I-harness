import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, resultExecution } from '@i-harness/core-tools'
import { createSession } from '@i-harness/core-session'
import { registerCodeMode } from '../src/register.ts'

it.each([
  ['throw new Error("original cell failure")', 'failed', 'failed'],
  ['text({status:"failed",outcome:"failed"})', 'completed', 'succeeded'],
  ['try { await tools.fail({}) } catch {} text("caught")', 'completed', 'succeeded'],
] as const)('declares code_exec original runtime observation for %s', async (code, status, outcome) => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  tools.register({ name: 'fail', description: '', inputSchema: {}, execute: async () => { throw new Error('nested failed') } })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: 'mixed' } })
  try {
    const call = await tools.prepare({ name: 'code_exec', args: { code, yield_time_ms: 60000 } })
    const output = await tools.dispatch(call)
    await tools.finalize(call, output)
    expect(output).toMatchObject({ status })
    expect(resultExecution(call)).toEqual({ outcome, dispatch: 'dispatched' })
  } finally { await mount.dispose() }
})

it('terminated launch is canceled while successful wait termination and status observation stay succeeded', async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const started = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
  tools.register({ name: 'held', description: '', inputSchema: {}, execute: async () => { started.resolve(); await held.promise; return 'done' } })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: 'mixed' } })
  try {
    const call = await tools.prepare({ name: 'code_exec', args: { code: 'await tools.held({})', yield_time_ms: 60000 } })
    const pending = tools.dispatch(call)
    await started.promise
    const stopping = mount.cancel('original owner stop'); held.resolve(); await stopping
    const output = await pending
    expect(output).toMatchObject({ status: 'terminated' })
    expect(resultExecution(call).outcome).toBe('canceled')
    const running = await tools.prepare({ name: 'code_exec', args: { code: 'await new Promise(() => {})', yield_time_ms: 0 } })
    const run = await tools.dispatch(running) as { cell_id: string }
    expect(resultExecution(running).outcome).toBe('succeeded')
    const wait = await tools.prepare({ name: 'code_wait', args: { cell_id: run.cell_id, terminate: true } })
    expect(await tools.dispatch(wait)).toMatchObject({ status: 'terminated' })
    expect(resultExecution(wait).outcome).toBe('succeeded')
    const status = await tools.prepare({ name: 'code_status', args: {} })
    await tools.dispatch(status)
    expect(resultExecution(status).outcome).toBe('succeeded')
    expect(resultExecution(running).outcome).toBe('succeeded')
  } finally { held.resolve(); await mount.dispose() }
})
