import { expect, it } from 'vitest'
import * as core from '../src/index.ts'
const d = 'a'.repeat(64)
const observation = () => ({ version: 2, ownerSessionId: 'owner', modelId: 'm', protocol: 'custom', bindingFingerprint: d, bindingRevision: 0, projectionRevision: 0,
  neutralFingerprint: d, identityCoverage: 'partial', purpose: 'media', estimate: { kind: 'unknown', reason: 'token-cost-unavailable' }, disposition: 'compatibility',
  dimensions: [{ dimension: 'context', state: 'unchecked' }], pressure: { kind: 'unavailable', reason: 'token-cost-unavailable' },
  components: { kind: 'estimated', source: 'projected-heuristic', user: 2, assistant: 0, tool: 0, system: 3, schema: 0, reasoning: 0 }, output: { capSupport: 'unknown', minimumCap: 1 },
  recoveryRequired: false, fullByProvider: false, freshness: 'current', requestContext: { version: 1, semanticRevision: d, protectionRevision: d, branchId: d, contextEpoch: d, surfaceRevision: d } })
it('decodes closed scalar unknown facts without inventing totals or executing accessors', () => {
  expect(core).toHaveProperty('validAdmissionObservation', expect.any(Function))
  const valid = (core as any).validAdmissionObservation
  expect(valid(observation())).toBe(true)
  expect(valid({ ...observation(), estimatedInputTokens: 0 })).toBe(false)
  expect(valid({ ...observation(), estimate: { kind: 'unknown', reason: 'raw sensitive error' } })).toBe(false)
  expect(valid({ ...observation(), dimensions: [...observation().dimensions, ...observation().dimensions] })).toBe(false)
  expect(valid(Object.defineProperty(observation(), 'estimate', { get() { throw Error('not data') }, enumerable: true }))).toBe(false)
})
