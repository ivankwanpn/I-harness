import { expect, it } from 'vitest'
import { createGeminiClient } from '../src/index.ts'
it.each([
  [{}, 'allowed'], [{ generation_config: { response_mime_type: null } }, 'allowed'], [{ generationConfig: { responseMimeType: 'text/plain', thinkingConfig: { thinkingBudget: 1024 } } }, 'allowed'],
  [{ generation_config: { response_mime_type: 'application/json', response_json_schema: {} } }, 'blocked'],
  [{ generationConfig: { responseMimeType: 'text/x.enum' } }, 'blocked'], [{ generationConfig: { responseMimeType: 'future' } }, 'unknown'],
  [{ generationConfig: { future: true } }, 'unknown'],
  ...[0, 1, 3, 4, 'AUTO', 'NONE', 'VALIDATED'].map(mode => [{ tool_config: { function_calling_config: { mode } } }, 'allowed']),
  ...[2, 'ANY'].map(mode => [{ toolConfig: { functionCallingConfig: { mode } } }, 'blocked']),
  [{ toolConfig: { functionCallingConfig: { mode: 99 } } }, 'unknown'],
] as [Record<string, unknown>, string][])('observes GenerateContent ProtoJSON final mode %j as %s', async (options, status) => {
  const p = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', options }).prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'recorded' }] })
  expect(p.textOutput?.status).toBe(status)
  expect(p.withOutputCap(256).textOutput?.status).toBe(status)
})
