import { expect, it, vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession } from '@i-harness/core-session'
import { createToolRegistry, instructionReplan, nativePlanValidationFailure, type AcceptedInstructionBatch } from '@i-harness/core-tools'
import { executeToolCalls } from '../src/execute-tool-calls.ts'

// Controlled acceptance fixture, without a physical transport or source authority.
it('preflights the complete known batch before any exclusive tool body starts', async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), effects: string[] = []
  for (const name of ['first', 'later']) tools.register({ name, description: '', inputSchema: {}, execute: async () => { effects.push(name); return name } })
  let observed = 0
  const batch: AcceptedInstructionBatch = { bind() { return Object.freeze({ kind: 'accepted-instruction-call' }) }, async preflight(entries) { observed = entries.length; throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'mixed-mutation', currentFingerprint: 'issued', splitRequired: true }) }, async release() {} }
  await executeToolCalls(ctx, session, tools, [{ callId: 'a', name: 'first', args: {} }, { callId: 'b', name: 'later', args: {} }], { maxParallel: 2, instructionBatch: batch })
  expect(observed).toBe(2); expect(effects).toEqual([])
  expect(session.events.filter(e => e.type === 'tool/result')).toMatchObject([{ callId: 'a', output: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } }, { callId: 'b', output: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } }])
  expect(session.events.filter(e => e.type === 'tool/dispatch')).toEqual([])
})

it('continues discovery after an expected malformed native plan', async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), effects: string[] = []
  tools.register({ name: 'bad', description: '', inputSchema: {}, captureNativePlan() { throw nativePlanValidationFailure({ error: 'bad patch', code: 'FS_EDIT_NOT_FOUND' }) }, execute: async () => { effects.push('bad') } })
  tools.register({ name: 'later', description: '', inputSchema: {}, execute: async () => { effects.push('later') } })
  let names: string[] = []
  const batch: AcceptedInstructionBatch = { bind() { return Object.freeze({ kind: 'accepted-instruction-call' }) }, async preflight(entries) { names = entries.map(entry => entry.registry.inspectCapture(entry.capture).call.name); throw instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'unseen-rules', currentFingerprint: 'issued' }) }, async release() {} }
  await executeToolCalls(ctx, session, tools, [{ callId: 'a', name: 'bad', args: {} }, { callId: 'b', name: 'later', args: {} }], { maxParallel: 2, instructionBatch: batch })
  expect(names).toEqual(['later']); expect(effects).toEqual([])
  expect(session.events.filter(e => e.type === 'tool/result')).toMatchObject([{ callId: 'a', output: { code: 'FS_EDIT_NOT_FOUND' } }, { callId: 'b', output: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } }])
})

it('drains an already started independent producer and fences later calls on a replan', async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), effects: string[] = []
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  tools.register({ name: 'held', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async (_args, exec) => { started.resolve(); await release.promise; expect(exec.abortSignal?.aborted).toBe(false); effects.push('held'); return 'actual' } })
  tools.register({ name: 'stale', description: '', inputSchema: {}, isConcurrencySafe: true, captureNativePlan: () => ({ targets: [{ path: process.cwd(), kind: 'directory', mode: 'mutate' }], operation: {} }), execute: async () => { effects.push('stale'); return 'bad' } })
  tools.register({ name: 'later', description: '', inputSchema: {}, execute: async () => { effects.push('later'); return 'bad' } })
  const failure = instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'changed-dependency', currentFingerprint: 'current' })
  const batch: AcceptedInstructionBatch = { bind() { return Object.freeze({ kind: 'accepted-instruction-call' }) }, async preflight(entries) { for (const entry of entries) if (entry.registry.inspectCapture(entry.capture).native) entry.registry.bindNativeInstructions(entry.capture, entry.origin, { assertCurrent() { throw failure }, before() {}, settle() {} }) }, async release() {} }
  const work = executeToolCalls(ctx, session, tools, [{ callId: 'a', name: 'held', args: {} }, { callId: 'b', name: 'stale', args: {} }, { callId: 'c', name: 'later', args: {} }], { maxParallel: 2, instructionBatch: batch })
  try {
    await started.promise
    await vi.waitFor(() => expect(session.events.some(e => e.type === 'tool/dispatch' && e.callId === 'b')).toBe(true))
    release.resolve(); await work
    expect(effects).toEqual(['held'])
    expect(session.events.filter(e => e.type === 'tool/result')).toMatchObject([{ callId: 'a', output: 'actual' }, { callId: 'b', output: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } }, { callId: 'c', output: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } }])
  } finally { release.resolve(); await work.catch(() => {}) }
})

it('replans a required native call that has no accepted origin', async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx, { instructionsRequired: true, instructionOriginVerifier: () => false })
  let effects = 0
  tools.register({ name: 'write', description: '', inputSchema: {}, captureNativePlan: () => ({ targets: [{ path: process.cwd(), kind: 'directory', mode: 'mutate' }], operation: {} }), execute: async () => { effects++; return 'done' } })
  await executeToolCalls(ctx, session, tools, [{ callId: 'a', name: 'write', args: {} }], { maxParallel: 1 })
  expect(effects).toBe(0)
  expect(session.events.filter(e => e.type === 'tool/result')).toMatchObject([{ output: { code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason: 'missing-origin' } }])
})

it('finds a later missing-origin mutation before an earlier non-native effect', async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx, { instructionsRequired: true, instructionOriginVerifier: () => false }), effects: string[] = []
  tools.register({ name: 'first', description: '', inputSchema: {}, execute: async () => { effects.push('first') } })
  tools.register({ name: 'write', description: '', inputSchema: {}, captureNativePlan: () => ({ targets: [{ path: process.cwd(), kind: 'directory', mode: 'mutate' }], operation: {} }), execute: async () => { effects.push('write') } })
  await executeToolCalls(ctx, session, tools, [{ callId: 'a', name: 'first', args: {} }, { callId: 'b', name: 'write', args: {} }], { maxParallel: 1 })
  expect(effects).toEqual([])
  expect(session.events.filter(e => e.type === 'tool/result')).toMatchObject([{ output: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } }, { output: { code: 'INSTRUCTIONS_REPLAN_REQUIRED' } }])
})
