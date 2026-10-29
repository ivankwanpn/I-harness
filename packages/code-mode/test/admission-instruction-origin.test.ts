import { expect, it } from 'vitest'
import { instructionReplan } from '@i-harness/core-tools'
import { createCodeModeRuntime } from '../src/runtime.ts'

it('binds the original cell capability with its receiver before publishing started', async () => {
  const trace: string[] = [], handle = Object.freeze({ kind: 'instruction-cell-origin' as const })
  let issued = ''
  const origin = { sessionId: 's', bindInstructionCell(id: string) { expect(this).toBe(origin); issued = id; trace.push('bind'); return handle } }
  const runtime = createCodeModeRuntime({ tools: () => [], invoke: async () => undefined, onEvent(event) {
    if (event.type === 'started') { trace.push('started'); expect(event.cellId).toBe(issued); expect((event.origin as typeof origin & { instructionOrigin?: unknown }).instructionOrigin).toBe(handle); expect('bindInstructionCell' in event.origin).toBe(false) }
  } })
  try { expect(await runtime.exec({ code: 'text(1)' }, origin as never)).toMatchObject({ status: 'completed' }); expect(trace).toEqual(['bind', 'started']) }
  finally { await runtime.dispose() }
})

it('cannot catch a genuine replan in guest code or commit a store write after it', async () => {
  const error = instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'changed-dependency', currentFingerprint: 'current' })
  let stores = 0
  const runtime = createCodeModeRuntime({ tools: () => [{ name: 'write', description: '', inputSchema: {} }], invoke: async () => { throw error }, commitStore: () => { stores++ } })
  try {
    const result = await runtime.exec({ code: "try { await tools.write({}) } catch { text('continued'); store('bad', true) }", yield_time_ms: 5000 })
    expect(result).toMatchObject({ status: 'failed', instructionReplan: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } })
    expect(result.text).not.toContain('continued'); expect(stores).toBe(0)
  } finally { await runtime.dispose() }
})

it('drains an already accepted independent call without abort before the replan terminal', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), stale = Promise.withResolvers<void>()
  let heldSignal: AbortSignal | undefined, effects = 0, terminals = 0, settled = false
  const error = instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'changed-dependency', currentFingerprint: 'current' })
  const runtime = createCodeModeRuntime({ tools: () => [{ name: 'held', description: '', inputSchema: {} }, { name: 'stale', description: '', inputSchema: {} }], async invoke(call) {
    if (call.name === 'held') { heldSignal = call.signal; started.resolve(); await release.promise; effects++; return 'actual' }
    await started.promise; stale.resolve(); throw error
  }, onEvent(event) { if (event.type === 'closed') terminals++ } })
  const work = runtime.exec({ code: "try { await Promise.all([tools.held({}), tools.stale({})]) } catch { text('caught') }", yield_time_ms: 5000 })
  void work.then(() => { settled = true }, () => { settled = true })
  try {
    await stale.promise; await new Promise<void>(resolve => setImmediate(resolve))
    expect(heldSignal?.aborted).toBe(false); expect(settled).toBe(false); expect(terminals).toBe(0)
    release.resolve(); const result = await work
    expect(result).toMatchObject({ status: 'failed', instructionReplan: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } })
    expect(result.text).not.toContain('caught'); expect(effects).toBe(1); expect(terminals).toBe(1)
  } finally { release.resolve(); await work.catch(() => {}); await runtime.dispose() }
})

it('waits for an accepted unawaited invocation before admitting a store commit', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined, stores = 0, effects = 0
  const runtime = createCodeModeRuntime({ tools: () => [{ name: 'held', description: '', inputSchema: {} }], async invoke(call) { signal = call.signal; started.resolve(); await release.promise; effects++; return 'actual' }, commitStore() { stores++ } })
  const origin = { bindInstructionCell: () => Object.freeze({ kind: 'instruction-cell-origin' as const }) }
  const work = runtime.exec({ code: "tools.held({}); store('value', 1)", yield_time_ms: 5000 }, origin)
  try {
    await started.promise; await new Promise<void>(resolve => setImmediate(resolve))
    expect(signal?.aborted).toBe(false); expect(stores).toBe(0)
    release.resolve(); expect(await work).toMatchObject({ status: 'completed' })
    expect([effects, stores]).toEqual([1, 1])
  } finally { release.resolve(); await work.catch(() => {}); await runtime.dispose() }
})

it('gives real Stop precedence over an in-progress replan drain', async () => {
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), stale = Promise.withResolvers<void>()
  let heldSignal: AbortSignal | undefined
  const error = instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'changed-dependency', currentFingerprint: 'current' })
  const runtime = createCodeModeRuntime({ tools: () => [{ name: 'held', description: '', inputSchema: {} }, { name: 'stale', description: '', inputSchema: {} }], async invoke(call) {
    if (call.name === 'held') { heldSignal = call.signal; started.resolve(); await release.promise; return 'actual' }
    await started.promise; stale.resolve(); throw error
  } })
  const work = runtime.exec({ code: 'await Promise.all([tools.held({}), tools.stale({})])', yield_time_ms: 5000 })
  try {
    await stale.promise; await new Promise<void>(resolve => setImmediate(resolve))
    const stop = runtime.cancel('real Stop'); expect(heldSignal?.aborted).toBe(true); release.resolve(); await stop
    const output = await work
    expect(output.status).toBe('terminated'); expect(output.instructionReplan).toBeUndefined()
  } finally { release.resolve(); await work.catch(() => {}); await runtime.dispose() }
})
