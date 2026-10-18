import { expect, it } from 'vitest'
import { resolveCompactSpec, resolveConfig } from '../src/config.ts'
it('resolves explicit presence before defaults and derives only an absent target', () => {
  expect(resolveConfig({ contextWindow: 10000 })).toMatchObject({ thresholdRatio: .8, targetRatio: .7, cooldown: { mode: 'accepted-exchanges', minimum: 3 } })
  expect(resolveConfig({ contextWindow: 10000, thresholdRatio: .6 })).toMatchObject({ targetRatio: .525 })
  expect(() => resolveConfig({ contextWindow: 10000, thresholdRatio: .6, targetRatio: .6 } as any)).toThrow(/target/i)
  expect(resolveConfig({ contextWindow: 10000, minTurnsBeforeRecompact: 3 })).toMatchObject({ cooldown: { mode: 'human-turns', minimum: 3 } })
  expect(() => resolveConfig({ contextWindow: 10000, minTurnsBeforeRecompact: 3, minExchangesBeforeRecompact: 3 } as any)).toThrow(/cooldown/i)
})
it('model cooldown selects its explicit mode while inherited explicit target stays explicit', () => {
  expect(resolveCompactSpec({ contextWindow: 10000, minTurnsBeforeRecompact: 4, modelPolicies: { 'p/m': { minExchangesBeforeRecompact: 2 } } } as any, 'p', 'm')).toMatchObject({ cooldown: { mode: 'accepted-exchanges', minimum: 2 } })
  expect(() => resolveCompactSpec({ contextWindow: 10000, targetRatio: .7, modelPolicies: { 'p/m': { thresholdRatio: .6 } } } as any, 'p', 'm')).toThrow(/target/i)
  expect(() => resolveCompactSpec({ contextWindow: 10000, modelPolicies: { 'p/m': { minTurnsBeforeRecompact: 2, minExchangesBeforeRecompact: 2 } } } as any, 'p', 'm')).toThrow(/cooldown/i)
})
