import { expect, it } from 'vitest'
import * as persistence from '../src/coordinator/bootstrap-intent.ts'

it('separates unmanaged, unassigned and project request identities with literal vectors', () => {
  const api = persistence as any
  expect(typeof api.createBootstrapRequestIntent).toBe('function')
  const core = { action: 'fork', selection: 'all' }
  for (const [project, digest] of [
    [{ kind: 'unmanaged' }, '46b13f207c607daebb363cf2b49643c8daa61e5d700d2d6f15ec159988de407f'],
    [{ kind: 'unassigned' }, '24abd936b5e77447bc62429793835c3c61d687229c457c86ad0b546af0f40d81'],
    [{ kind: 'project', projectId: 'p1' }, '11983dbae96a5b3587edbbc2529d8d484789b2f068f3439e4152d7be688eea3e'],
  ] as const) {
    const result = api.createBootstrapRequestIntent(core, project)
    expect(result).toEqual({ intent: { version: 1, requestCoreDigest: '4295bdd53cabc311b9c1fc8e291db61e046318fa68f4c5cc5b779cf87609b41f', project }, requestDigest: digest })
    const invocation = { version: 1, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: digest }
    const captured = api.captureBootstrapRequestIntent(invocation, result.intent)
    expect(captured).toEqual(result.intent); expect(captured).not.toBe(result.intent); expect(Object.isFrozen(captured.project)).toBe(true)
    expect(() => api.captureBootstrapRequestIntent({ ...invocation, requestDigest: '0'.repeat(64) }, result.intent)).toThrow()
  }
})
it('rejects hidden, accessor, proxy, symbol, undefined and JSON-dropping intent observations without evaluating them', () => {
  const api = persistence as any
  expect(typeof api.createBootstrapRequestIntent).toBe('function')
  let calls = 0
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { calls++; return 1 } })
  const hidden = Object.defineProperty({}, 'value', { value: 1 })
  for (const core of [getter, hidden, { nested: hidden }, new Proxy({}, { ownKeys() { calls++; return [] } }), { [Symbol()]: 1 }, { value: undefined }, [undefined], Array(1), { toJSON() { calls++; return {} } }]) {
    expect(() => api.createBootstrapRequestIntent(core, { kind: 'unassigned' })).toThrow()
  }
  for (const project of [{ kind: 'unmanaged', projectId: 'p' }, { kind: 'project', projectId: '' }, { kind: 'project', projectId: 'bad\n' }, Object.defineProperty({ kind: 'unassigned' }, 'hidden', { value: 1 })]) {
    expect(() => api.createBootstrapRequestIntent({}, project)).toThrow()
  }
  expect(calls).toBe(0)
})
