import { expect, it, vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession } from '@i-harness/core-session'
import { createToolRegistry, retainInstructionCell, instructionReplan, type InstructionCellOrigin } from '@i-harness/core-tools'
import { createCodeModeBroker } from '../src/broker.ts'

// Explicit host-injected origin fixture; it does not claim physical delivery.
it('preflights the full queued cell set before either nested native body', async () => {
  const ctx = createContext(), session = createSession(), origin = Object.freeze({ kind: 'accepted-instruction-call' as const }), traces: string[] = []
  let cellOrigin: InstructionCellOrigin | undefined, observed = 0
  const lease = { bind() { return origin }, async preflight(entries: readonly import('@i-harness/core-tools').InstructionBatchEntry[]) { observed = entries.length; for (const entry of entries) entry.registry.bindNativeInstructions(entry.capture, entry.origin, { assertCurrent() {}, before() {}, settle() {} }) }, async release() {} }
  const tools = createToolRegistry(ctx, { instructionsRequired: true, instructionOriginVerifier: value => value === origin, instructionCellRetainer: () => lease })
  const block = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  tools.register({ name: 'block', description: '', inputSchema: {}, execute: async () => { entered.resolve(); await block.promise; return 'released' } })
  tools.register({ name: 'write', description: '', inputSchema: {}, captureNativePlan: args => ({ targets: [{ path: process.cwd(), kind: 'directory', mode: 'mutate' }], operation: args }), execute: async () => { traces.push('write'); return 'ok' } })
  tools.register({ name: 'outer', description: '', inputSchema: {}, execute: async (_args, exec) => { cellOrigin = retainInstructionCell(exec, 'c'); return 'yield' } })
  const outer = tools.capture({ name: 'outer', args: {} }); await tools.dispatch(await tools.prepareCaptured(outer, undefined, origin))
  const broker = createCodeModeBroker(ctx, tools, { session }); broker.startCell('block'); (broker.startCell as any)('c', cellOrigin)
  const call = (cellId: string, invocationId: string, name: string) => ({ cellId, invocationId, name, args: {}, origin: { instructionOrigin: cellId === 'c' ? cellOrigin : undefined }, signal: new AbortController().signal })
  const blocker = broker.invoke(call('block', 'block', 'block')); await entered.promise
  const first = broker.invoke(call('c', 'a', 'write')), second = broker.invoke(call('c', 'b', 'write'))
  try {
    await vi.waitFor(() => expect(session.events.filter(event => event.type === 'code/call')).toHaveLength(3))
    block.resolve(); await Promise.all([blocker, first, second])
    expect(observed).toBe(2); expect(traces).toEqual(['write', 'write'])
  } finally { block.resolve(); await Promise.allSettled([blocker, first, second]); broker.retireCell('c'); await broker.finishRetiredCell('c'); await broker.dispose() }
})

it.each([false, true])('arbitrates preflight policy before replan and guest delivery (policy=%s)', async policy => {
  const ctx = createContext(), session = createSession(), origin = Object.freeze({ kind: 'accepted-instruction-call' as const }), trace: string[] = []
  let cellOrigin: InstructionCellOrigin | undefined
  const error = instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'unseen-rules', currentFingerprint: 'current' })
  if (policy) Object.assign(error, { policyRefusal: true })
  const lease = { bind() { return origin }, async preflight() { throw error }, async release() {} }
  const tools = createToolRegistry(ctx, { instructionsRequired: true, instructionOriginVerifier: value => value === origin, instructionCellRetainer: () => lease })
  tools.register({ name: 'write', description: '', inputSchema: {}, captureNativePlan: () => ({ targets: [{ path: process.cwd(), kind: 'directory', mode: 'mutate' }], operation: {} }), execute: async () => { trace.push('body') } })
  tools.register({ name: 'outer', description: '', inputSchema: {}, execute: async (_args, exec) => { cellOrigin = retainInstructionCell(exec, 'c') } })
  const outer = tools.capture({ name: 'outer', args: {} }); await tools.dispatch(await tools.prepareCaptured(outer, undefined, origin))
  const broker = createCodeModeBroker(ctx, tools, { session }, () => { trace.push('latched') }); (broker.startCell as any)('c', cellOrigin)
  try {
    await expect(broker.invoke({ cellId: 'c', invocationId: 'a', name: 'write', args: {}, origin: { instructionOrigin: cellOrigin }, signal: new AbortController().signal })).rejects.toBe(error)
    trace.push('guest-rejected'); expect(trace).toEqual(policy ? ['guest-rejected'] : ['latched', 'guest-rejected'])
    if (policy) expect(session.events.filter(event => event.type === 'code/result')).toMatchObject([{ output: { code: 'POLICY_REFUSAL' } }])
  } finally { await broker.drainCell('c'); if (policy) await broker.finishRetiredCell('c'); else await broker.finishReplannedCell('c'); await broker.dispose() }
})

it('detects a later missing-origin native call before an earlier queued non-native effect', async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx, { instructionsRequired: true, instructionOriginVerifier: () => false }), effects: string[] = []
  const block = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  tools.register({ name: 'block', description: '', inputSchema: {}, execute: async () => { entered.resolve(); await block.promise; return 'done' } })
  tools.register({ name: 'first', description: '', inputSchema: {}, execute: async () => { effects.push('first') } })
  tools.register({ name: 'write', description: '', inputSchema: {}, captureNativePlan: () => ({ targets: [{ path: process.cwd(), kind: 'directory', mode: 'mutate' }], operation: {} }), execute: async () => { effects.push('write') } })
  const broker = createCodeModeBroker(ctx, tools, { session }); broker.startCell('block'); broker.startCell('c')
  const call = (cellId: string, invocationId: string, name: string) => ({ cellId, invocationId, name, args: {}, origin: {}, signal: new AbortController().signal })
  const blocker = broker.invoke(call('block', 'x', 'block')); await entered.promise
  const first = broker.invoke(call('c', 'a', 'first')), write = broker.invoke(call('c', 'b', 'write'))
  void first.catch(() => {}); void write.catch(() => {})
  try {
    await vi.waitFor(() => expect(session.events.filter(event => event.type === 'code/call')).toHaveLength(3))
    block.resolve(); await blocker
    await expect(first).rejects.toMatchObject({ code: 'INSTRUCTIONS_REPLAN_REQUIRED' })
    await expect(write).rejects.toMatchObject({ code: 'INSTRUCTIONS_REPLAN_REQUIRED' })
    expect(effects).toEqual([])
  } finally { block.resolve(); await Promise.allSettled([blocker, first, write]); await broker.drainCell('c'); await broker.finishReplannedCell('c'); await broker.dispose() }
})

it('keeps the cell pin through a held preflight and gives Stop precedence over replan', async () => {
  const ctx = createContext(), session = createSession(), origin = Object.freeze({ kind: 'accepted-instruction-call' as const }), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let cellOrigin: InstructionCellOrigin | undefined, released = 0, latches = 0, effects = 0
  const lease = { bind() { return origin }, async preflight() { entered.resolve(); await release.promise; throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'unseen-rules', currentFingerprint: 'current' }) }, async release() { released++ } }
  const tools = createToolRegistry(ctx, { instructionsRequired: true, instructionOriginVerifier: value => value === origin, instructionCellRetainer: () => lease })
  tools.register({ name: 'write', description: '', inputSchema: {}, captureNativePlan: () => ({ targets: [{ path: process.cwd(), kind: 'directory', mode: 'mutate' }], operation: {} }), execute: async () => { effects++ } })
  tools.register({ name: 'outer', description: '', inputSchema: {}, execute: async (_args, exec) => { cellOrigin = retainInstructionCell(exec, 'c') } })
  const outer = tools.capture({ name: 'outer', args: {} }); await tools.dispatch(await tools.prepareCaptured(outer, undefined, origin))
  const broker = createCodeModeBroker(ctx, tools, { session }, () => { latches++ }); broker.startCell('c', cellOrigin)
  const invocation = broker.invoke({ cellId: 'c', invocationId: 'a', name: 'write', args: {}, origin: { instructionOrigin: cellOrigin }, signal: new AbortController().signal }); void invocation.catch(() => {})
  try {
    await entered.promise; const stopping = broker.dispose(); void stopping.catch(() => {}); await new Promise<void>(resolve => setImmediate(resolve)); expect(released).toBe(0)
    release.resolve(); await expect(stopping).rejects.toBeDefined(); await expect(invocation).rejects.toBeDefined()
    await broker.finishRetiredCell('c'); await broker.dispose()
    expect([released, latches, effects]).toEqual([1, 0, 0])
  } finally { release.resolve(); await invocation.catch(() => {}); await broker.dispose().catch(() => {}) }
})
