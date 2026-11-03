import { expect, it } from 'vitest'
import { createAnthropicClient } from '../src/index.ts'
it.each([
  [{}, 'allowed'], [{ output_config: { effort: 'high' } }, 'allowed'], [{ thinking: { type: 'adaptive' } }, 'allowed'],
  [{ output_config: { format: { type: 'json_schema', schema: {} } } }, 'blocked'], [{ tool_choice: { type: 'any' } }, 'blocked'],
  [{ tool_choice: { type: 'tool', name: 'read' } }, 'blocked'], [{ thinking: { type: 'future' } }, 'unknown'],
  [{ output_config: { future: true } }, 'unknown'], [{ future: true }, 'unknown'],
  [{ output_config: { format: { type: 'json' } } }, 'unknown'], [{ output_config: { format: { type: 'json_object' } } }, 'unknown'],
] as const)('observes Messages final mode %j as %s', async (options, status) => {
  const p = await createAnthropicClient({ apiKey: 'controlled', model: 'fixture', options }).prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'recorded' }] })
  expect(p.textOutput?.status).toBe(status)
  expect(p.withOutputCap(256).textOutput?.status).toBe(status)
})
