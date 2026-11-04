import { expect, it } from 'vitest'
import { validateSemanticBootstrapAppend } from '../src/index.ts'

const event = (type: string, seq: number) => ({ type, version: 1, seq }) as never

it('accepts appended regular events and rejects seed/bootstrap types (S-06 step 2)', () => {
  expect(() => validateSemanticBootstrapAppend(4, [event('turn/start', 4)], 11)).not.toThrow()
  expect(() => validateSemanticBootstrapAppend(4, [event('session/bootstrap', 4)], 11)).toThrow()
  expect(() => validateSemanticBootstrapAppend(4, [event('conversation/seed-manifest', 4)], 11)).toThrow()
})
