import { expect, it } from 'vitest'
import { createMockClient } from '../src/index.ts'

it('the factory stream retains its private implementation when a standalone fixture replaces the public preparation slot', async () => {
  const client = createMockClient([{ role: 'assistant', text: 'original cassette' }])
  let replacedCalls = 0
  client.prepare = async () => { replacedCalls++; throw new Error('Replaced public preparation must not run from factory stream') }
  const events = []
  for await (const event of client.stream({ messages: [], tools: [], systemPrompt: '' })) events.push(event)
  expect(events).toEqual([{ type: 'text/chunk', text: 'original cassette' }, { type: 'end' }])
  expect(replacedCalls).toBe(0)
})
