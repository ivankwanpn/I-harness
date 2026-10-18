import { expect, it } from 'vitest'
import { createOpenAICompatibleClient } from '../src/index.ts'
const request = { systemPrompt: '', tools: [], messages: [{ role: 'user' as const, content: 'recorded' }] }
it.each([
  [{}, 'allowed'], [{ response_format: { type: 'text' } }, 'allowed'], [{ reasoning_effort: 'high' }, 'allowed'],
  [{ tool_choice: { type: 'allowed_tools', allowed_tools: { mode: 'auto', tools: [] } } }, 'allowed'],
  [{ response_format: { type: 'json_object' } }, 'blocked'], [{ response_format: { type: 'json_schema', json_schema: { name: 'checkpoint', schema: {} } } }, 'blocked'],
  [{ tool_choice: 'required' }, 'blocked'], [{ tool_choice: { type: 'function', function: { name: 'read' } } }, 'blocked'],
  [{ response_format: { type: 'future' } }, 'unknown'], [{ extension: true }, 'unknown'], [{ reasoning_effort: 'future' }, 'unknown'],
  [{ response_format: { type: 'json_object' }, extension: true }, 'blocked'],
] as const)('observes the final Chat body %j as %s', async (options, status) => {
  const prepared = await createOpenAICompatibleClient({ apiKey: 'controlled', model: 'fixture', options }).prepare!(request)
  expect(prepared.textOutput?.status).toBe(status)
  expect(prepared.withOutputCap(256).textOutput?.status).toBe(status)
})
