import { afterEach, expect, it, vi } from 'vitest'
import { deriveMessages, createSession } from '../../core-session/src/index.ts'
import { createAnthropicClient } from '../src/index.ts'
import { PNG } from '../../image-validation/test/fixtures.ts'

afterEach(() => vi.unstubAllGlobals())
const bad = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
it('quarantines a corrupt historical image without editing the original log or replay messages', async () => {
  const session = createSession()
  session.events.push(
    { type: 'user/message', text: 'inspect' },
    { type: 'tool/call', name: 'code_wait', callId: 'legacy', args: {cell_id:'old'} },
    { type: 'tool/result', name: 'code_wait', callId: 'legacy', output: { text:'original tool text', images: [{ mediaType: 'image/png', dataBase64: bad }, {mediaType:'image/png',dataBase64:PNG}] } },
    { type: 'user/message', text: 'try again' },
  )
  const original = JSON.stringify(session.events)
  const messages = deriveMessages(session), before = JSON.stringify(messages)
  let body = ''
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { body = String(init.body); return new Response('', { status: 200 }) })
  const client = createAnthropicClient({ apiKey: 'offline-test', model: 'test', inputModalities: ['text', 'image'] })
  for await (const _ of client.stream({ messages, tools: [], systemPrompt: '' })) { /* no network */ }
  expect(body).not.toContain(bad)
  expect(body).toMatch(/Image unavailable.*invalid/i)
  expect(body).toContain(PNG)
  expect(body).toContain('original tool text')
  expect(body).toContain('legacy')
  expect(JSON.stringify(messages)).toBe(before)
  expect(JSON.stringify(session.events)).toBe(original)
})
