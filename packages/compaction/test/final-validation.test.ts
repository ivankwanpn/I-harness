import { expect, it } from 'vitest'
import { ProjectionCounter } from '@i-harness/token-meter'
import { validationCollector, type PreparedModelRequest } from '@i-harness/llm-seam'
import { prepareSummary } from '../src/prepared-summary.ts'
it('rejects invalid selected summary report before pricing or executing it', async () => {
  const counter = new ProjectionCounter(), input = counter.finish({ protocol: 'openai-compatible', modelId: 'm' }, [], {})
  const check = validationCollector('openai-compatible'); check.issue('tool-group', 'messages', 'message-order')
  let sends = 0
  const selected: PreparedModelRequest = { validation: check.finish().report, measurement: { projectionId: input.inputFingerprint, input, output: { capSupport: 'supported', minimumCap: 1, effectiveCap: 10, source: 'request' }, packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } }, withOutputCap() { return this }, async *stream() { sends++; yield { type: 'end' } } }
  const initial: PreparedModelRequest = { ...selected, validation: undefined, withOutputCap: () => selected }
  await expect(prepareSummary({ async prepare() { return initial }, async *stream() { throw Error('raw') } }, { systemPrompt: '', messages: [], tools: [] }, 100, { maxOutputTokens: 10 }, () => {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'message-order' } })
  expect(sends).toBe(0)
})
