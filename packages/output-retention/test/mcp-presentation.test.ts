import { expect, it } from 'vitest'
import { createResultCapture } from '../src/index.ts'
import { mcpPresentation } from '../src/result/mcp-presentation.ts'
import { PNG } from '../../image-validation/test/fixtures.ts'

async function refused(value: unknown, marked = true) {
  return createResultCapture(value, { outcome: 'succeeded', dispatch: 'dispatched' }, {
    ...(marked ? { presentation: 'mcp' as const } : {}),
    async openArtifact() { throw Object.assign(new Error('fixture quota'), { code: 'ARTIFACT_QUOTA' }) },
  }).settle()
}

it.each([
  { type: 'audio', mimeType: 'audio/wav', data: 'QUJD' },
  { type: 'image', mimeType: 'image/bmp', data: 'invalid bytes' },
  { type: 'resource', resource: { uri: 'file:///a', mimeType: 'application/octet-stream', blob: 'SECRET_BLOB' } },
  { type: 'resource_link', uri: 'https://example.invalid/a', name: 'link' },
  { type: 'future', data: 'SECRET_BLOB' },
])('keeps a small marked non-text $type out of ordinary inline text', async block => {
  const value = { content: [block], isError: false, structuredContent: null }
  const result = await refused(value)
  expect(result).toMatchObject({ kind: 'ready', envelope: { execution: { outcome: 'succeeded' }, retention: { kind: 'unavailable', reason: 'quota' } }, program: { kind: 'value', value } })
  if (result.kind !== 'ready') throw new Error('Expected ready quota disposition')
  expect(result.envelope.preview).toContain('[1]')
  expect(result.envelope.preview).toContain(block.type)
  expect(result.envelope.preview).not.toContain('SECRET_BLOB')
  expect(result.envelope.preview).not.toContain('invalid bytes')
  expect(result.envelope.preview).not.toContain('QUJD')
  expect(result.envelope.preview).not.toMatch(/retained|available in the full result/)
})

it('caps escaped fields before composition, discloses remaining blocks, and retains all owned data', async () => {
  const text = '"\\\u0000\ud800😀'.repeat(100_000)
  const value = { content: [
    { type: 'resource', resource: { uri: 'URI_START' + text, mimeType: 'TYPE_START' + text, text: 'TEXT_START' + text } },
    { type: 'resource_link', uri: 'LINK_START' + text, name: 'NAME_START' + text },
    ...Array.from({ length: 1000 }, () => ({ type: 'text', text })),
  ], structuredContent: { sentinel: 'fully preserved' } }
  const result = await refused(value)
  if (result.kind !== 'ready' || result.program.kind !== 'value') throw new Error('Expected preserved owned value')
  expect(result.program.value).toEqual(value)
  expect(Buffer.byteLength(JSON.stringify(result.envelope.preview))).toBeLessThanOrEqual(8192)
  expect(result.envelope.preview).toContain('URI_START')
  expect(result.envelope.preview).toContain('NAME_START')
  expect(result.envelope.preview).toMatch(/\d+ (?:more|remaining) blocks/)
  expect(result.envelope.preview).toContain('Structured content')
  expect(JSON.stringify(result.envelope.preview)).toContain('\\u0000')
})

it.each([{ content: [], structuredContent: null }, { content: [{ type: 'text', text: 'small' }], structuredContent: { answer: 42 } }, { structuredContent: null }])('preserves the existing small text/empty/transformed inline behavior: %j', async value => {
  expect(await refused(value)).toMatchObject({ kind: 'ready', envelope: { retention: { kind: 'inline', value } }, program: { kind: 'value', value } })
})

it('does not infer presentation or failure from ordinary lookalike payload keys', async () => {
  const value = { content: [{ type: 'audio', mimeType: 'audio/wav', data: 'QUJD' }], isError: true, error: 'payload', ref: { id: 'not-authority' } }
  expect(await refused(value, false)).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value } } })
})

it('bounds individual escaped text and descriptor fields before joining the summary', () => {
  const preview = mcpPresentation({ content: [
    { type: 'text', text: '"'.repeat(1_000_000) },
    { type: 'resource_link', uri: '\\'.repeat(1_000_000), name: '\u0000'.repeat(1_000_000) },
  ] })!.preview
  const [textLine, linkLine] = preview.split('\n')
  expect(textLine).toBe('[1] text: ' + '"'.repeat(1023))
  expect(linkLine).toBe('[2] resource_link: ' + '\\'.repeat(511) + ' name: ' + '\u0000'.repeat(170) + ' ()')
  expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(8192)
})

it('preserves existing native image extraction on unmarked ordinary results', async () => {
  const value = { images: [{ mediaType: 'image/png', dataBase64: PNG }], isError: true }
  const result = await refused(value, false)
  expect(result).toMatchObject({ envelope: { execution: { outcome: 'succeeded' }, media: value.images }, program: { kind: 'value', value } })
})
