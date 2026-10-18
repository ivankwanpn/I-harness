import { expect, it } from 'vitest'
import { createOpenAIClient } from '../src/index.ts'
const request = { systemPrompt: '', tools: [], messages: [{ role: 'user' as const, content: 'recorded' }] }
it.each([false, true])('observes actual public/subscription final controls (%s)', async codexSubscription => {
  for (const [options, status] of [
    [{}, 'allowed'], [{ text: { format: { type: 'text' }, verbosity: 'low' }, reasoning: { effort: 'high', summary: 'auto' } }, 'allowed'],
    [{ text: { format: { type: 'json_object' } } }, 'blocked'], [{ tool_choice: 'required' }, 'blocked'],
    [{ tool_choice: { type: 'function', name: 'read' } }, 'blocked'], [{ tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [] } }, 'allowed'],
    [{ tool_choice: { type: 'allowed_tools', mode: 'required', tools: [] } }, 'blocked'],
    [{ text: { format: { type: 'future' } } }, 'unknown'], [{ reasoning: { future: true } }, 'unknown'],
  ] as const) {
    const p = await createOpenAIClient({ apiKey: 'controlled', model: 'fixture', codexSubscription, options }).prepare!(request)
    expect(p.textOutput?.status).toBe(status)
    expect(p.withOutputCap(256).textOutput?.status).toBe(status)
  }
})
it('observes subscription filtering instead of discarded raw options', async () => {
  const p = await createOpenAIClient({ apiKey: '', model: 'fixture', codexSubscription: true, options: { temperature: 1, future: true } }).prepare!(request)
  expect(p.textOutput).toEqual({ status: 'allowed', reason: 'ordinary-text' })
})
