import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, retainInstructionCell, bindInstructionInvocation, preflightInstructionInvocations, releaseInstructionCell, type InstructionCellOrigin } from '../src/index.ts'

// Explicitly injected accepted-evidence test fixture, not a physical receipt.
it('keeps the cell lease after the outer call and rejects copied origins', async () => {
  const accepted = Object.freeze({ kind: 'accepted-instruction-call' as const }), nested = Object.freeze({ kind: 'accepted-instruction-call' as const })
  let active = true, acquired = 0, released = 0, preflights = 0, cell: InstructionCellOrigin | undefined
  const lease = { bind(invocationId: string) { expect(this).toBe(lease); expect(invocationId).toBe('nested'); return nested }, async preflight() { expect(this).toBe(lease); preflights++ }, async release() { expect(this).toBe(lease); released++ } }
  const ctx = createContext()
  ctx.onCascade('tools/execute', async (input, next) => { const exec = (input as { exec: import('../src/types.ts').ToolExec }).exec; expect(() => retainInstructionCell(exec, 'forged')).toThrow(); return next() })
  const registry = createToolRegistry(ctx, { instructionOriginVerifier: (origin) => origin === accepted && active, instructionCellRetainer(origin, _capture, cellId) { expect(origin).toBe(accepted); expect(cellId).toBe('cell'); acquired++; return lease } })
  registry.register({ name: 'code_exec', description: '', inputSchema: {}, execute: async (_args, exec) => { cell = retainInstructionCell(exec, 'cell'); return 'done' } })
  registry.register({ name: 'nested', description: '', inputSchema: {}, execute: async () => 'ok' })
  const outer = registry.capture({ name: 'code_exec', args: {} }); await registry.dispatch(await registry.prepareCaptured(outer, undefined, accepted))
  expect(acquired).toBe(1); active = false
  const capture = registry.capture({ name: 'nested', args: {} })
  expect(() => bindInstructionInvocation({ ...cell! }, 'nested', capture)).toThrow()
  expect(bindInstructionInvocation(cell!, 'nested', capture)).toBe(nested)
  await preflightInstructionInvocations(cell!, [{ registry, capture, origin: nested }])
  await releaseInstructionCell(cell!); await releaseInstructionCell(cell!)
  expect([preflights, released]).toEqual([1, 1])
  expect(() => bindInstructionInvocation(cell!, 'nested', capture)).toThrow()
})

it('revokes the prepared body context after return even for an inherited asynchronous callback', async () => {
  const accepted = Object.freeze({ kind: 'accepted-instruction-call' as const }), done = Promise.withResolvers<void>()
  let acquired = 0, failure: unknown
  const registry = createToolRegistry(createContext(), { instructionOriginVerifier: value => value === accepted, instructionCellRetainer: () => { acquired++; return { bind() { return accepted }, async preflight() {}, async release() {} } } })
  registry.register({ name: 'code_exec', description: '', inputSchema: {}, execute: async (_args, exec) => {
    setImmediate(() => { try { retainInstructionCell(exec, 'late') } catch (error) { failure = error }; done.resolve() })
    return 'done'
  } })
  const capture = registry.capture({ name: 'code_exec', args: {} }); await registry.dispatch(await registry.prepareCaptured(capture, undefined, accepted)); await done.promise
  expect(failure).toBeInstanceOf(Error); expect(acquired).toBe(0)
})
