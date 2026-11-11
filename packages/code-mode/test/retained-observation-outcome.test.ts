import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { decodeFactBatch } from '@i-harness/core-session'
import { createToolRegistry, retainedToolOutcome, resultExecution } from '@i-harness/core-tools'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { registerCodeMode } from '../src/register.ts'

it.each([
  { tool: 'code_exec', failed: false, terminated: false, direct: false, expected: 'succeeded' },
  { tool: 'code_exec', failed: true, terminated: false, direct: false, expected: 'failed' },
  { tool: 'code_wait', failed: false, terminated: false, direct: false, expected: 'succeeded' },
  { tool: 'code_wait', failed: true, terminated: false, direct: false, expected: 'succeeded' },
  { tool: 'code_wait', failed: false, terminated: true, direct: false, expected: 'succeeded' },
  { tool: 'code_wait', failed: true, terminated: false, direct: true, expected: 'succeeded' },
] as const)('$tool terminal failed=$failed terminated=$terminated direct=$direct keeps its original query outcome', async ({ tool, failed, terminated, direct, expected }) => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'code-retained-outcome-'))
  const started = Promise.withResolvers<void>(), releaseStart = Promise.withResolvers<void>()
  const terminal = Promise.withResolvers<void>(), releaseTerminal = Promise.withResolvers<void>()
  let terminalWrites = 0
  const backend = createJsonlBackend(root, { wrapOwnedBatch: original => async (...args) => {
    const events = decodeFactBatch(args[3].bytes).events
    if (tool === 'code_exec' && events.some(event => event.type === 'code/cell' && event.state === 'started')) {
      started.resolve(); await releaseStart.promise
    }
    if (events.some(event => event.type === 'code/cell' && ['completed', 'failed', 'terminated'].includes(event.state))) {
      terminalWrites++; terminal.resolve(); await releaseTerminal.promise
    }
    return original(...args)
  } })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  const identity = { session: document.view, sessionId: id, settlementSource: source }
  const code = failed ? 'throw new Error("original cell failure")' : terminated ? 'await new Promise(() => {})' : 'void 0'
  let flight: Promise<unknown> | undefined
  try {
    let prepared
    if (tool === 'code_wait') {
      const launch = await tools.prepare({ name: 'code_exec', args: { code, yield_time_ms: 0 } }, undefined, identity)
      const initial = await tools.dispatch(launch) as { cell_id: string; status: string }
      expect(initial.status).toBe('running')
      if (!terminated) await terminal.promise
      prepared = await tools.prepare({ name: 'code_wait', args: { cell_id: initial.cell_id, yield_time_ms: direct ? 60000 : 100, terminate: terminated } }, undefined, identity)
      if (!direct) vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      else releaseTerminal.resolve()
      flight = tools.dispatch(prepared)
      void flight.catch(() => {})
      if (terminated) await terminal.promise
    } else {
      prepared = await tools.prepare({ name: 'code_exec', args: { code, yield_time_ms: 100 } }, undefined, identity)
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      flight = tools.dispatch(prepared)
      void flight.catch(() => {})
      await started.promise
      releaseStart.resolve()
      await terminal.promise
    }
    if (direct) {
      expect(await flight).toMatchObject({ status: 'failed' })
      expect(resultExecution(prepared)).toEqual({ outcome: expected, dispatch: 'dispatched' })
      expect(terminalWrites).toBe(1)
      return
    }
    const rejected = flight.then(() => { throw new Error('Expected held terminal receipt recovery') }, error => error)
    void rejected.catch(() => {})
    await vi.advanceTimersByTimeAsync(100)
    const error = await rejected
    expect(error).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    const retained = retainedToolOutcome(error, prepared)
    expect(retained).toBeDefined()
    expect(document.view.events.some(event => event.type === 'code/cell' && event.state === (failed ? 'failed' : 'completed'))).toBe(false)
    vi.useRealTimers()
    releaseTerminal.resolve()
    const value = await retained!.take()
    expect(value).toMatchObject({ kind: 'ready', output: { status: terminated ? 'terminated' : failed ? 'failed' : 'completed' } })
    expect(resultExecution(prepared)).toEqual({ outcome: expected, dispatch: 'dispatched' })
    expect(await retained!.take()).toEqual({ kind: 'recovery-required' })
    expect(terminalWrites).toBe(1)
  } finally {
    vi.useRealTimers(); releaseStart.resolve(); releaseTerminal.resolve()
    await flight?.catch(() => {})
    await mount.dispose(); await source.close(); action.finish(); await coordinator.close(); await ctx.scope.unmount()
  }
}, 15000)
