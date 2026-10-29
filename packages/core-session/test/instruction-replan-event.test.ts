import { expect, it } from 'vitest'
import { validateConversationEventShape } from '../src/index.ts'

it('bounds the optional instruction replan on a failed code cell while keeping old cells readable', () => {
  const detail = { code: 'INSTRUCTIONS_REPLAN_REQUIRED', currentFingerprint: 'abc', reason: 'changed-dependency' }
  expect(() => validateConversationEventShape({ type: 'code/cell', cellId: 'c', state: 'failed', instructionReplan: detail } as never, 13)).not.toThrow()
  expect(() => validateConversationEventShape({ type: 'code/cell', cellId: 'c', state: 'completed' }, 13)).not.toThrow()
  for (const invalid of [{ ...detail, reason: 'invented' }, { ...detail, effectsUnknown: Array(257).fill('x') }, { ...detail, extra: true }]) {
    expect(() => validateConversationEventShape({ type: 'code/cell', cellId: 'c', state: 'failed', instructionReplan: invalid } as never, 13)).toThrow()
  }
  expect(() => validateConversationEventShape({ type: 'code/cell', cellId: 'c', state: 'completed', instructionReplan: detail } as never, 13)).toThrow()
})
