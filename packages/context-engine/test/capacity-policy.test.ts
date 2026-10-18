import { describe, expect, it } from 'vitest'
import * as engine from '../src/index.ts'

const numeric = (value: number) => ({ value, origin: 'explicit-route' as const, sourceId: 'fixture-capacity' })
const input = (I = 8400, R: number | undefined = 600) => ({
  purpose: 'main' as const, estimate: { kind: 'estimated' as const, value: I, source: 'projected-heuristic' as const },
  limits: { contextTokens: numeric(10000) },
  capacityDomain: { kind: 'known' as const, value: 'shared-context' as const, sourceId: 'fixture-domain' },
  output: { capSupport: 'supported' as const, parameter: 'optional' as const, effectiveCap: R, minimumCap: 1 },
  packet: { kind: 'http-json-body' as const, bytes: 100 },
  policy: { safetyRatio: .1, triggerRatio: .8, targetRatio: .7, strictCapacity: false },
})
function assess(value: ReturnType<typeof input> | any) {
  expect(engine).toHaveProperty('assessCapacity', expect.any(Function))
  return (engine as any).assessCapacity(value)
}
describe('shared capacity policy independent literal oracles', () => {
  it('uses additive safety and bounded output with exact inclusive boundaries', () => {
    expect(assess(input()).pressure).toEqual({ kind: 'known', basis: 'shared-context', input: 8400, inputBudget: 8400, trigger: 6720, target: 5880, hardFits: true, softNeeded: true, targetReady: false })
    expect(assess(input(8401)).disposition).toBe('reduce')
    expect(assess(input(6720)).pressure.softNeeded).toBe(true)
    expect(assess(input(6719)).pressure.softNeeded).toBe(false)
    expect(assess(input(5880)).pressure.targetReady).toBe(true)
    expect(assess(input(5881)).pressure.targetReady).toBe(false)
    expect(assess(input(0, 2000)).pressure).toMatchObject({ inputBudget: 7000, trigger: 5600, target: 4900 })
    expect(assess({ ...input(), purpose: 'summary', policy: { ...input().policy, safetyRatio: .05 } }).pressure.inputBudget).toBe(8900)
  })
  it('keeps omitted output and proven input-only capacity honest', () => {
    const omitted = { ...input(0), output: { ...input().output, effectiveCap: undefined } }
    expect(assess(omitted).pressure.inputBudget).toBe(9000)
    expect(assess(omitted).dimensions).toContainEqual({ dimension: 'output', state: 'unchecked' })
    expect(assess({ ...input(), capacityDomain: { kind: 'known', value: 'input-only', sourceId: 'fixture-input' } }).pressure.inputBudget).toBe(10000)
  })
  it('distinguishes unknown, coupling assumption, ceiling conflict and strict capacity', () => {
    expect(assess({ ...input(), limits: { contextCeilingTokens: numeric(10000) } })).toMatchObject({ disposition: 'compatibility', pressure: { kind: 'unavailable', reason: 'unconfigured' } })
    expect(assess({ ...input(), capacityDomain: { kind: 'unknown', reason: 'coupling-unverified' } })).toMatchObject({ disposition: 'compatibility', pressure: { basis: 'legacy-shared-assumption', inputBudget: 8400 } })
    expect(assess({ ...input(), limits: { contextTokens: numeric(10000), contextCeilingTokens: numeric(9000) } })).toMatchObject({ disposition: 'blocked', reason: 'capacity-conflict' })
    expect(assess({ ...input(), limits: {}, policy: { ...input().policy, strictCapacity: true } })).toMatchObject({ disposition: 'blocked', reason: 'strict-capacity-required' })
  })
  it('checks exact HTTP bytes independently and never promotes an SDK estimate', () => {
    expect(assess({ ...input(0), limits: { bodyBytes: numeric(100) }, packet: { kind: 'http-json-body', bytes: 101 } })).toMatchObject({ disposition: 'reduce', reason: 'body-overflow' })
    expect(assess({ ...input(0), limits: { bodyBytes: numeric(100) }, packet: { kind: 'sdk-command-estimate', bytes: 101 } }).dimensions).toContainEqual({ dimension: 'http-bytes', state: 'unchecked', limit: 100, sourceId: 'fixture-capacity' })
    expect(assess({ ...input(0), limits: { ...input().limits, bodyBytes: numeric(100) }, packet: { kind: 'sdk-command-estimate', bytes: 101 } }).disposition).toBe('compatibility')
  })
  it('does not turn unknown local media into a zero input or positive fit', () => {
    const result = assess({ ...input(), purpose: 'media', estimate: { kind: 'unknown', reason: 'token-cost-unavailable' } })
    expect(result).toMatchObject({ disposition: 'compatibility', pressure: { kind: 'unavailable', reason: 'token-cost-unavailable' } })
    expect(result.pressure).not.toHaveProperty('input')
  })
  it('keeps decimal threshold arithmetic exact at independently specified integer boundaries', () => {
    expect(assess({ ...input(0,1000), limits: { contextTokens: numeric(100000) } }).pressure).toMatchObject({ inputBudget: 89000, trigger: 71200, target: 62300 })
  })
  it.each([NaN, Infinity, -1, .5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid priced input %s before any derivative or issuance', value => {
    expect(()=>assess(input(value))).toThrow(/capacity policy/)
  })
})

it('keeps dimension scalars safe when individually valid input and output overflow their combined sum',()=>{
 const result=assess(input(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER))
 expect(result.disposition).toBe('reduce');expect(result.dimensions.find((d:any)=>d.dimension==='context')).toEqual({dimension:'context',state:'fail',limit:10000,sourceId:'fixture-capacity'})
 expect(result.dimensions.every((d:any)=>d.actual===undefined||Number.isSafeInteger(d.actual))).toBe(true)
})
