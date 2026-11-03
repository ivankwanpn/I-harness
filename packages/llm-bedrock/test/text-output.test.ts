import { expect, it } from 'vitest'
import { createBedrockClient } from '../src/index.ts'
import { observeTextOutput } from '../src/request/text-output.ts'
it.each([
  [{}, 'allowed'], [{ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }, 'allowed'],
  [{ reasoningConfig: { type: 'enabled', maxReasoningEffort: 'high' } }, 'allowed'],
  [{ output_config: { format: { type: 'json_schema', schema: {} } } }, 'blocked'], [{ future: true }, 'unknown'],
  [{ response_format: { type: 'json_schema' } }, 'unknown'], [{ output_config: { format: { type: 'json_object' } } }, 'unknown'],
  [{ tool_choice: { type: 'any' } }, 'unknown'],
  [{ output_config: { format: { type: 'json' } } }, 'unknown'],
] as const)('observes actual Converse additional fields %j as %s', async (options, status) => {
  const p = await createBedrockClient({ model: 'fixture', options }, { async send() { throw Error('deny unmatched transport') }, destroy() {} }).prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'recorded' }] })
  expect(p.textOutput?.status).toBe(status)
  expect(p.withOutputCap(256).textOutput?.status).toBe(status)
})
it('interprets Converse toolChoice at its command location instead of raw additional fields', () => {
  expect(observeTextOutput({ modelId: 'fixture', messages: [], toolConfig: { tools: [], toolChoice: { auto: {} } } })).toEqual({ status: 'allowed', reason: 'ordinary-text' })
  for (const toolChoice of [{ any: {} }, { tool: { name: 'read' } }]) expect(observeTextOutput({ modelId: 'fixture', messages: [], toolConfig: { tools: [], toolChoice }, additionalModelRequestFields: { future: true } })).toEqual({ status: 'blocked', reason: 'forced-tool' })
})
