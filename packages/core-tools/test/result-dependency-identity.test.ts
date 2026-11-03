import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '../src/index.ts'
import { registerToolResultDependency, toolResultDependencies, type ToolResultDependency } from '../src/registry/result-dependencies.ts'
import type { ToolExec } from '../src/types.ts'

it('accepts only a genuine prepared producer, deduplicates its exact handle, and retains authentic identity conflict', async () => {
  const tools = createToolRegistry(createContext())
  tools.register({ name: 'identity', description: 'identity seam', inputSchema: {}, async execute() { return {} } })
  const prepared = await tools.prepare({ name: 'identity', args: {} })
  const first: ToolResultDependency = { sourceId: 'actual-owner-seam', async settle() { throw new Error('A conflict must never settle one side as authoritative') } }
  expect(registerToolResultDependency({ ...prepared.exec } as ToolExec, first)).toBe(false)
  expect(registerToolResultDependency(prepared.exec, first)).toBe(true)
  expect(registerToolResultDependency(prepared.exec, first)).toBe(true)
  expect(toolResultDependencies(prepared.exec)).toEqual([first])
  const conflicting: ToolResultDependency = { sourceId: first.sourceId, async settle() { throw new Error('Conflict side must remain conservative') } }
  expect(registerToolResultDependency(prepared.exec, conflicting)).toBe(false)
  const sources = toolResultDependencies(prepared.exec)
  expect(sources).toHaveLength(1)
  expect(await sources[0]!.settle()).toEqual({ kind: 'recovery-required' })
})
