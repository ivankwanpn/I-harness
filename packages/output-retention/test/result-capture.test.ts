import { expect, it, vi } from 'vitest'
import * as retention from '../src/index.ts'
import type { ResultEnvelope, ResultExecution } from '@i-harness/core-session'
import type { ResultArtifactSink } from '@i-harness/context-output'
import { createContextOutputService } from '@i-harness/context-output'
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

type Capture = (value: unknown, execution: ResultExecution, options: { openArtifact(): Promise<ResultArtifactSink> }) => { settle(): Promise<{ kind: string; envelope?: ResultEnvelope; program?: unknown }> }
it('captures source callbacks synchronously once and returns the owned program value independently of its model preview', async () => {
  let reads = 0, conversions = 0
  const source = { late: { answer: 42 }, get field() { reads++; return 'before' }, custom: { toJSON() { conversions++; return ['owned'] } } }
  const capture = (retention as unknown as { createResultCapture?: Capture }).createResultCapture?.(source, { outcome: 'succeeded', dispatch: 'dispatched' }, { async openArtifact() { throw new Error('Small result must remain inline') } })
  source.late.answer = 99
  const result = await capture?.settle()
  expect(result).toMatchObject({ kind: 'ready', program: { kind: 'value', value: { late: { answer: 42 }, field: 'before', custom: ['owned'] } } })
  expect({ reads, conversions }).toEqual({ reads: 1, conversions: 1 })
  expect(result?.envelope?.retention.kind).toBe('inline')
})

it('resumes its retained encoding cursor after the original body chunk write fails without lowering the source again', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-capture-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'cut-')), service = createContextOutputService({ root, workspaceId: 'w' })
  const probe = await open(resolve(root, 'probe'), 'w'), prototype = Object.getPrototypeOf(probe), originalWrite = prototype.write
  await probe.close()
  let reads = 0, cut = false
  const source = { get body() { reads++; return 'x'.repeat(1_048_576) } }
  const capture = retention.createResultCapture(source, { outcome: 'succeeded', dispatch: 'dispatched' }, { async openArtifact() {
    const scope = service.registerResultScope({ operationId: 'original-cut', sessionId: 'a', callId: 'c' }, () => true)
    return service.beginResult(scope, 'json-utf8-v1')
  } })
  const spy = vi.spyOn(prototype, 'write').mockImplementation(async function(this: unknown, ...args: unknown[]) {
    const bytes = args[0]
    if (!cut && bytes instanceof Uint8Array && bytes.length >= 4096) {
      cut = true; await Reflect.apply(originalWrite, this, [bytes, 0, 17, args[3]])
      throw new Error('original captured-body write cut')
    }
    return Reflect.apply(originalWrite, this, args)
  })
  try {
    expect(await capture.settle()).toMatchObject({ kind: 'recovery-required' })
    spy.mockRestore()
    const result = await capture.settle()
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready' || result.envelope.retention.kind !== 'artifact') throw new Error('Expected original capture commitment')
    expect(result.envelope.retention.ref.encodedBytes).toBe(1_048_587)
    expect(result.envelope.retention.ref.contentDigest).toBe(createHash('sha256').update('{"body":"').update('x'.repeat(1_048_576)).update('"}').digest('hex'))
    expect(reads).toBe(1)
  } finally { vi.restoreAllMocks(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains genuine root/nested/array raw tokens as exact artifacts with owned markers and leaves fake shapes inline', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-capture-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'raw-')), service = createContextOutputService({ root, workspaceId: 'w' })
  const raw = (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON
  const fixtures = [
    { value: raw('9007199254740993'), encoded: '9007199254740993' },
    { value: { nested: raw('1e400') }, encoded: '{"nested":1e400}' },
    { value: [raw('1e-400'), raw('"\\u0061"'), raw('9007199254740993')], encoded: '[1e-400,"\\u0061",9007199254740993]' },
    { value: raw('"' + 'a'.repeat(16382) + '😀"'), encoded: '"' + 'a'.repeat(16382) + '😀"' },
  ]
  let reads = 0, conversions = 0
  let cold: ReturnType<typeof createContextOutputService> | undefined
  const pages: { ref: import('@i-harness/core-session').ManagedArtifactRef; expected: string }[] = []
  try {
    for (const [index, fixture] of fixtures.entries()) {
      let scope: ReturnType<typeof service.registerResultScope> | undefined
      const originalValue = fixture.value, source = { toJSON() { conversions++; return fixture.value } }
      const capture = retention.createResultCapture(Object.defineProperty({}, 'data', { enumerable: true, get() { reads++; return source } }), { outcome: 'succeeded', dispatch: 'dispatched' }, { async openArtifact() {
        scope ??= service.registerResultScope({ operationId: 'raw-' + index, sessionId: 'a', callId: 'c' + index }, () => true)
        return service.beginResult(scope, 'json-utf8-v1')
      } })
      fixture.value = { replaced: true }
      const result = await capture.settle()
      expect(result).toHaveProperty('envelope.retention.kind', 'artifact')
      if (result.kind !== 'ready' || result.envelope.retention.kind !== 'artifact' || result.program.kind !== 'value') throw new Error('Expected exact raw artifact and program')
      const expected = '{"data":' + fixture.encoded + '}', ref = result.envelope.retention.ref
      expect(ref.contentDigest).toBe(createHash('sha256').update(expected).digest('hex'))
      expect(JSON.stringify(result.program.value)).toBe(expected)
      expect((result.program.value as { data: unknown }).data).not.toBe(originalValue)
      expect((await service.readResult({ sessionId: 'a' }, { ref })).data).toEqual({ kind: 'text', text: expected })
      pages.push({ ref, expected })
    }
    const fake = await retention.createResultCapture({ rawJSON: '9007199254740993' }, { outcome: 'succeeded', dispatch: 'dispatched' }, { async openArtifact() { throw new Error('Ordinary small JSON data remains inline') } }).settle()
    expect(fake).toHaveProperty('envelope.retention.kind', 'inline')
    expect({ reads, conversions }).toEqual({ reads: 4, conversions: 4 })
    const originalRaw = raw('9007199254740993'), rootCapture = retention.createResultCapture(originalRaw, { outcome: 'succeeded', dispatch: 'dispatched' }, { async openArtifact() { return service.beginResult(service.registerResultScope({ operationId: 'raw-root', sessionId: 'a', callId: 'root' }, () => true), 'json-utf8-v1') } })
    const rootResult = await rootCapture.settle()
    if (rootResult.kind !== 'ready' || rootResult.envelope.retention.kind !== 'artifact' || rootResult.program.kind !== 'value') throw new Error('Expected exact root raw artifact')
    expect(rootResult.program.value).not.toBe(originalRaw)
    expect(Object.isFrozen(rootResult.program.value)).toBe(true)
    pages.push({ ref: rootResult.envelope.retention.ref, expected: '9007199254740993' })
    await service.close(); cold = createContextOutputService({ root, workspaceId: 'w' })
    for (const { ref, expected } of pages) expect((await cold.readResult({ sessionId: 'a' }, { ref })).data).toEqual({ kind: 'text', text: expected })
  } finally { await cold?.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})
