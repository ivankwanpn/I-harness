import { describe, expect, it } from 'vitest'
import { compareBudgetTotal } from '../src/index.ts'

describe('compareBudgetTotal', () => {
  it('charges the supplied complete total exactly once', () => {
    expect(compareBudgetTotal(901, 1000, .9)).toEqual({ state: 'overflow', tokens: 901, budget: 900 })
    expect(() => compareBudgetTotal(NaN, 1000)).toThrow(/tokens/)
  })
  it('returns ok for a literal total under budget', () => {
    expect(compareBudgetTotal(24, 10000)).toEqual({ state: 'ok', tokens: 24, budget: 9000 })
  })
  it('returns overflow for a literal total over budget', () => {
    expect(compareBudgetTotal(504, 100, .5)).toEqual({ state: 'overflow', tokens: 504, budget: 50 })
  })
  it('validates reserve ratio', () => {
    expect(() => compareBudgetTotal(24, 100, 0)).toThrow(/reserveRatio/)
    expect(() => compareBudgetTotal(24, 100, 1.5)).toThrow(/reserveRatio/)
  })
  it('preserves the inclusive boundary and rejects invalid totals', () => {
    expect(compareBudgetTotal(9000, 10000, .9)).toEqual({ state: 'ok', tokens: 9000, budget: 9000 })
    expect(compareBudgetTotal(9001, 10000, .9)).toEqual({ state: 'overflow', tokens: 9001, budget: 9000 })
    for (const value of [-1, .5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => compareBudgetTotal(value, 10000)).toThrow(/tokens/)
  })
})
