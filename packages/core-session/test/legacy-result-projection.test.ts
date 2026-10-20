import { expect, it } from 'vitest'
import { append, createSession, deriveMessages, fromJSONL, toJSONL } from '../src/index.ts'

// Literal predecessor rows enter through the real public reader. They are
// historical raw data; they do not become new typed-media/envelope facts.
const image = { mediaType: 'image/png', dataBase64: 'YQ==', name: 'shot.png', width: 12, height: 7 }
const rows = [
  ['plain', 'The quick brown fox'],
  ['image', { images: [image] }],
  ['mixed', { note: 'original', images: [image] }],
  ['empty', { images: [] }],
  ['null', { images: null }],
  ['string', { images: 'nope' }],
  ['object', { images: { mediaType: 'image/png' } }],
] as const
it.each(rows)('cold decodes and projects historical raw %s output without manufacturing retention', (_label, output) => {
  const raw = JSON.stringify({ formatVersion: 1 }) + '\n' + [
    { type: 'tool/call', callId: 'original', name: 'corpus', args: {}, seq: 0 },
    { type: 'tool/result', callId: 'original', name: 'corpus', output, seq: 1 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  const cold = fromJSONL(raw), result = cold.events[1]
  expect(result).toEqual({ type: 'tool/result', callId: 'original', name: 'corpus', output, seq: 1 })
  expect(result).not.toHaveProperty('envelope')
  const message = deriveMessages(cold).find(message => message.role === 'tool')!
  const descriptor = 'image: shot.png 12x7 3B base64:YQ=='
  const expected = _label === 'image' ? descriptor : _label === 'mixed' ? '{"note":"original"}\n' + descriptor : JSON.stringify(output)
  expect(message.content).toBe(expected)
  expect(fromJSONL(toJSONL(cold)).events).toEqual(cold.events)
})

it('keeps historical outputPaths/notice/code data and explicit new-intake image rejection separate', () => {
  const output = { code: 'TOOL_TIMEOUT', error: 'original', output: 'Full result stored at: historical-path', outputPaths: ['historical-path'], spill: { retention: 'temporary' } }
  const cold = fromJSONL('{"formatVersion":1}\n' + JSON.stringify({ type: 'tool/result', callId: 'old', name: 'shell', output, seq: 0 }) + '\n')
  expect(cold.events[0]).toMatchObject({ output })
  expect(deriveMessages(cold).find(message => message.role === 'tool')?.content).toBe(JSON.stringify(output))
  expect(() => append(createSession(), { type: 'tool/result', callId: 'new', name: 'strict', output: { images: { mediaType: 'image/png' } } })).toThrow(/images must be an array/)
})
