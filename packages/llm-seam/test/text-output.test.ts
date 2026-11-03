import { expect, it } from 'vitest'
import { createPreparedPayload, readPreparedTextOutput, wrapPreparedRequest, type PreparedTextOutput } from '../src/index.ts'
import { ProjectionCounter } from '@i-harness/token-meter'

function payload(blocked: boolean) {
  return createPreparedPayload({ body: { blocked }, request: { systemPrompt: '', messages: [], tools: [] },
    textOutput: body => body.blocked ? { status: 'blocked', reason: 'structured-output' } : { status: 'allowed', reason: 'ordinary-text' },
    describe(body) { const c = new ProjectionCounter(); c.structured('otherInput', body); return { input: c.finish({ protocol: 'fixture', modelId: 'm' }, body, {}), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
    output: () => ({ capSupport: 'supported', minimumCap: 1, source: 'request' }), cap: body => ({ blocked: !body.blocked }),
    async *execute() { yield { type: 'end' } },
  })
}
it.each([true, false])('recomputes the actual derivative mode and propagates it through wrappers (%s)', blocked => {
  const a = payload(blocked), b = wrapPreparedRequest(a, (stream, control) => stream(control)).withOutputCap(32)
  expect(readPreparedTextOutput(a).status).toBe(blocked ? 'blocked' : 'allowed')
  expect(readPreparedTextOutput(b).status).toBe(blocked ? 'allowed' : 'blocked')
  expect(Object.isFrozen(b.textOutput)).toBe(true)
})
it('reads only a closed owned data observation without invoking accessors', () => {
  let reads = 0
  const accessor = { get textOutput(): PreparedTextOutput { reads++; throw Error('must not run') } }
  expect(readPreparedTextOutput(accessor)).toEqual({ status: 'unknown', reason: 'invalid-declaration' })
  for (const value of [Object.create({ status: 'allowed', reason: 'ordinary-text' }), { status: 'allowed', get reason() { reads++; return 'ordinary-text' } }, { status: 'allowed', reason: 'ordinary-text', raw: 'private' }, { status: 'allowed', reason: 'ordinary-text', [Symbol()]: true }]) {
    expect(readPreparedTextOutput({ textOutput: value })).toEqual({ status: 'unknown', reason: 'invalid-declaration' })
  }
  expect(readPreparedTextOutput({})).toEqual({ status: 'unknown', reason: 'not-declared' })
  expect(readPreparedTextOutput({ textOutput: undefined })).toEqual({ status: 'unknown', reason: 'not-declared' })
  const proxy = Proxy.revocable({}, {}); proxy.revoke()
  expect(readPreparedTextOutput({ textOutput: proxy.proxy as PreparedTextOutput })).toEqual({ status: 'unknown', reason: 'invalid-declaration' })
  const inheritedRaw = Object.assign(Object.create({ raw: 'private' }), { status: 'allowed', reason: 'ordinary-text' })
  expect(readPreparedTextOutput({ textOutput: inheritedRaw })).toEqual({ status: 'unknown', reason: 'invalid-declaration' })
  expect(reads).toBe(0)
})
