import { expect, it } from 'vitest'
import { createPreparedPayload, preparedControls } from '../src/index.ts'
import { ProjectionCounter } from '@i-harness/token-meter'
it('confirms exact frozen facts once per invocation and composes both immediate guards', async () => {
  const seen: any[] = [], calls: string[] = []
  const prepared = createPreparedPayload({ body: { x: 1 }, request: { systemPrompt: '', messages: [], tools: [], validateBeforeTransport: () => calls.push('request') },
    describe(body) { const c = new ProjectionCounter('projected-pricing-v2'); c.structured('otherInput', body); return { input: c.finish({ protocol: 'test', modelId: 'm' }, body, body), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
    output: () => ({ capSupport: 'supported', minimumCap: 1, source: 'request' }), cap: b => b,
    async *execute(_b, _s, _c, execution) { expect(execution?.confirm).toBeTypeOf('function'); execution.confirm({ version: 1, runtimeId: 'r', bindingLifetimeId: 'b', authEpoch: 'E', scope: 'binding-credential', coldCompatible: false }); calls.push('send'); yield { type: 'end' } },
  })
  for (let i = 0; i < 2; i++) for await (const _e of prepared.stream({ validateBeforeTransport: () => calls.push('owned'), confirmExecution: c => seen.push(c) })) {}
  expect(calls).toEqual(['request', 'owned', 'send', 'request', 'owned', 'send'])
  expect(seen[0]).toMatchObject({ semanticId: prepared.measurement.input.semanticIdentity!.semanticId, payloadId: prepared.measurement.payloadIdentity!.id, payloadKind: 'http-json-body' })
  expect(seen[0].sendId).not.toBe(seen[1].sendId)
  expect(Object.isFrozen(seen[0])).toBe(true)
})
it('deduplicates the same request guards and collectors across nested execution wrappers', () => {
  const calls: string[] = [], guard = () => calls.push('guard'), owned = () => calls.push('owned')
  const request = { validateBeforeTransport: guard }
  const first = preparedControls(request, { validateBeforeTransport: owned })
  const second = preparedControls(request, first)
  preparedControls(first, second).validateBeforeTransport?.()
  expect(calls).toEqual(['guard','owned'])
})
