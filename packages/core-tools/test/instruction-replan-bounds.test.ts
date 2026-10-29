import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { validateConversationEventShape } from '@i-harness/core-session'
import { createToolRegistry, instructionReplan } from '../src/index.ts'
import { observationOutput } from '../../code-mode/src/observation-output.ts'

it('preserves all 257/1024 native effects through bounded observation and persistence', () => {
  for (const count of [257, 1024]) {
    const paths = Array.from({ length: count }, (_, i) => `${process.cwd()}/file-${i}`), registry = createToolRegistry(createContext())
    registry.register({ name: 'native', description: '', inputSchema: {}, captureNativePlan: () => ({ targets: paths.map(path => ({ path, kind: 'file', mode: 'mutate' })), operation: {} }), execute: async () => {} })
    expect(registry.inspectCapture(registry.capture({ name: 'native', args: {} })).native!.targets).toHaveLength(count)
    const detail = instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', currentFingerprint: '', reason: 'changed-dependency', applied: paths }).data
    const output = observationOutput({ cellId: 'c', status: 'failed', text: '', truncated: false, items: [], instructionReplan: detail })
    if (output.instructionEffects) { expect(output.instructionEffects).toEqual({ omitted: true, applied: count, notApplied: 0, effectsUnknown: 0 }); expect(output.instructionReplan!.applied).toBeUndefined() }
    else expect(output.instructionReplan!.applied).toEqual(paths)
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(64000)
    expect(detail.applied).toEqual(paths)
    expect(() => validateConversationEventShape({ type: 'code/cell', cellId: 'c', state: 'failed', instructionReplan: detail }, 13)).not.toThrow()
    paths[0] = 'changed'; expect(detail.applied![0]).not.toBe('changed')
  }
})

it('rejects over-limit effect producers before copying a DTO into observation', () => {
  const base = { code: 'INSTRUCTIONS_REPLAN_REQUIRED' as const, currentFingerprint: '', reason: 'changed-dependency' as const }
  expect(() => instructionReplan({ ...base, effectsUnknown: Array(1025).fill('x') })).toThrow()
  expect(() => instructionReplan({ ...base, applied: Array(600).fill('x'), notApplied: Array(600).fill('y') })).toThrow()
  expect(() => instructionReplan({ ...base, applied: ['x'.repeat(4097)] })).toThrow()
})
