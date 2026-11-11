import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { generateSelectedSummary } from '../src/summary/generate.ts'
import { summarySource } from './fixtures/summary.ts'
import { spyModel } from './fixtures/history.ts'
import { RecordedPages } from '../src/summary/pages.ts'
import { recordedSegments } from '../src/summary/source.ts'
import { prepareTextFixture, checkpointOfLength } from './fixtures/checkpoint.ts'
import type { ModelClient, LLMRequest, PreparedModelRequest } from '@i-harness/llm-seam'
import { append, createSession } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'

// CJK costs one token per character; the full source must exceed the 32k window.
it('pages every byte of one oversized closed group, including emoji and empty text', async () => {
  const content = '𠜎中\u0000'.repeat(24000), fixture = spyModel()
  const source = summarySource([{ role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read', args: { path: 'large' } }] }, { role: 'tool', toolCallId: 'read', content }])
  const result = await generateSelectedSummary(fixture.model, source, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 32000 })
  expect(result.groupIds).toEqual(['literal-0'])
  expect(fixture.requests.length).toBeGreaterThan(1)
  const fragments = fixture.requests.flatMap(request => request.messages.slice(0, -1).flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(part => part.type === 'text').flatMap(part => {
    try { const data = JSON.parse(part.text); return data.fragment ? [data] : [] } catch { return [] }
  })))
  const results = fragments.filter(data => data.source.field === 'tool-text')
  expect(results.map(data => data.text).join('')).toBe(content)
  let cursor = 0
  for (const data of results) { expect(data.fragment.startByte).toBe(cursor); cursor += Buffer.byteLength(data.text); expect(data.fragment.endByte).toBe(cursor); expect(data.fragment.digest).toBe(createHash('sha256').update(content).digest('hex')) }
  expect(cursor).toBe(Buffer.byteLength(content))
  expect(fragments.some(data => data.fragment.totalBytes === 0)).toBe(true)
  expect(source.attempts.count).toBe(fixture.requests.length)
})
it('represents an empty ordinary source with an explicit zero-length marker', () => {
  const pages = new RecordedPages(summarySource([{ role: 'user', content: '' }]).groups)
  const page = pages.candidate(); expect(page.ranges).toMatchObject([{ startByte: 0, endByte: 0, totalBytes: 0 }])
  pages.accept(page); expect(pages.complete).toBe(true)
})
it.each(['missing', 'duplicate', 'order', 'digest', 'text', 'manifest'] as const)('rejects %s coverage before advancing the source cursor', corruption => {
  const pages = new RecordedPages(summarySource([{ role: 'assistant', content: 'abcdef', toolCalls: [{ id: 'c', name: 'read', args: { a: 1 } }] }, { role: 'tool', toolCallId: 'c', content: 'middle FACT' }]).groups)
  const original = pages.candidate(), page = structuredClone(original) as any
  if (corruption === 'missing') page.ranges.pop()
  if (corruption === 'duplicate') page.ranges.push(page.ranges[0])
  if (corruption === 'order') page.ranges.reverse()
  if (corruption === 'digest') page.ranges[0].digest = 'wrong'
  if (corruption === 'text') page.messages[0].content[0].text = '{}'
  if (corruption === 'manifest') page.manifest = '{}'
  expect(() => pages.accept(page)).toThrow(expect.objectContaining({ kind: 'source-unrepresentable' }))
  expect(pages.complete).toBe(false); expect(pages.candidate().digest).toBe(original.digest)
  pages.accept(original); expect(pages.complete).toBe(true)
  expect(() => pages.accept(original)).toThrow(expect.objectContaining({ kind: 'source-unrepresentable' }))
})
it('keeps large canonical arguments, control characters and media descriptors in original segment order', () => {
  const image = { type: 'image' as const, image: { mediaType: 'image/png' as const, dataBase64: 'aGVsbG8=' } }
  const source = summarySource([{ role: 'assistant', content: 'answer', toolCalls: [{ id: 'c', name: 'read', args: { z: '\u0000😀'.repeat(30000), a: 1 } }] },
    { role: 'tool', toolCallId: 'c', content: [{ type: 'text', text: 'caption' }, image] }])
  const pages = new RecordedPages(source.groups), texts: string[] = [], media: unknown[] = []
  while (!pages.complete) { const page = pages.candidate(); expect(page.textBytes).toBeLessThanOrEqual(65536); for (const message of page.messages) if (Array.isArray(message.content)) for (const part of message.content) {
    if (part.type === 'image') media.push(part)
    else if (part.type === 'text') { const data = JSON.parse(part.text); if (data.source.field === 'call-arguments') texts.push(data.text) }
  } pages.accept(page) }
  expect(texts.join('')).toBe(JSON.stringify({ a: 1, z: '\u0000😀'.repeat(30000) }))
  expect(media).toEqual([image])
  expect(recordedSegments(source.groups).map(segment => segment.source.field)).toEqual(['assistant-text', 'call-arguments', 'content-part-text', 'media'])
})
it('refuses unpaired surrogates rather than silently changing projected text bytes', () => {
  expect(() => new RecordedPages(summarySource([{ role: 'user', content: 'x\ud800y' }]).groups)).toThrow(expect.objectContaining({ kind: 'source-unrepresentable' }))
})
it('exhausts eight physical calls without returning partial group coverage', async () => {
  const fixture = spyModel(), source = summarySource([{ role: 'user', content: 'x'.repeat(600000) }])
  await expect(generateSelectedSummary(fixture.model, source, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 100000 })).rejects.toMatchObject({ kind: 'call-limit' })
  expect(fixture.requests).toHaveLength(8); expect(source.attempts.count).toBe(8)
})
// A 50k-character CJK source exceeds 32k tokens; each 64 KiB page still fits.
it('one malformed page retry reuses exactly the uncovered range and the shared call allowance', async () => {
  const requests: LLMRequest[] = [], source = summarySource([{ role: 'user', content: '中'.repeat(50000) }])
  const model: ModelClient = { prepare: prepareTextFixture, async *stream(request) { requests.push(request); yield { type: 'text/chunk', text: requests.length === 1 ? 'bad' : checkpointOfLength(600) }; yield { type: 'end' } } }
  await generateSelectedSummary(model, source, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 32000 })
  expect(requests[0]!.messages[0]).toEqual(requests[1]!.messages[0]); expect(requests[2]!.messages[0]).not.toEqual(requests[1]!.messages[0])
  expect(source.attempts.count).toBe(requests.length)
})
it.each(['stale', 'stop'] as const)('rejects a held successful page after %s without advancing the ledger', async mode => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController(), source = summarySource([{ role: 'user', content: '中'.repeat(50000) }])
  let current = true, calls = 0, accepted = 0
  const model: ModelClient = { prepare: prepareTextFixture, async *stream() { calls++; entered.resolve(); await release.promise; yield { type: 'text/chunk', text: checkpointOfLength(600) }; yield { type: 'end' } } }
  const promise = generateSelectedSummary(model, { ...source, current: () => current, signal: abort.signal }, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 32000, onPieceAccepted: () => { accepted++ } })
  await entered.promise; if (mode === 'stop') abort.abort(Error('held Stop')); else current = false; release.resolve()
  await expect(promise).rejects.toThrow(mode === 'stop' ? 'held Stop' : 'Selected summary source changed')
  expect(calls).toBe(1); expect(accepted).toBe(0)
})
it('confirmed page overflow consumes physical budget, failed usage, and one measured sizing correction', async () => {
  const source = summarySource([{ role: 'user', content: '中'.repeat(50000) }]), requests: LLMRequest[] = [], preparations: any[] = [], usage: unknown[] = []
  const model: ModelClient = { prepare: prepareTextFixture, async *stream(request) {
    requests.push(request); yield { type: 'usage', usage: { inputTokens: 10 } }
    if (requests.length === 1) throw Object.assign(Error('confirmed'), { code: 'CONTEXT_WINDOW_EXCEEDED' })
    yield { type: 'text/chunk', text: checkpointOfLength(600) }; yield { type: 'end' }
  } }
  await generateSelectedSummary(model, source, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 32000, onPreparation: facts => { preparations.push(facts) }, onUsage: value => { usage.push(value) } })
  expect(requests.length).toBeGreaterThan(3); expect(source.attempts.count).toBe(requests.length); expect(usage).toHaveLength(requests.length)
  const pages = preparations.filter(facts => facts.mode === 'page')
  expect(pages[1].sourceBytes).toBeLessThan(pages[0].sourceBytes); expect(pages.at(-1).sizingCorrections).toBe(1)
  const fragments = requests.slice(1).flatMap(request => (request.messages[0]!.content as any[]).map(part => JSON.parse(part.text)).map(data => data.text))
  expect(fragments.join('')).toBe('中'.repeat(50000))
})
it('two sizing corrections are invocation-wide even after successfully accepted pages', async () => {
  const source = summarySource([{ role: 'user', content: '中'.repeat(100000) }]), preparations: any[] = []
  let calls = 0
  const model: ModelClient = { prepare: prepareTextFixture, async *stream() {
    calls++; if (calls !== 2) throw Object.assign(Error('confirmed'), { code: 'CONTEXT_WINDOW_EXCEEDED' })
    yield { type: 'text/chunk', text: checkpointOfLength(600) }; yield { type: 'end' }
  } }
  await expect(generateSelectedSummary(model, source, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 100000, onPreparation: facts => { preparations.push(facts) } })).rejects.toMatchObject({ kind: 'shrink-limit' })
  expect(calls).toBe(4); expect(source.attempts.count).toBe(4); expect(Math.max(...preparations.map(facts => facts.sizingCorrections))).toBe(2)
})
it('does not give each page another malformed-output corrective round', async () => {
  const source = summarySource([{ role: 'user', content: '中'.repeat(50000) }]); let calls = 0
  const model: ModelClient = { prepare: prepareTextFixture, async *stream() { calls++; yield { type: 'text/chunk', text: calls % 2 ? 'bad' : checkpointOfLength(600) }; yield { type: 'end' } } }
  await expect(generateSelectedSummary(model, source, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 32000 })).rejects.toMatchObject({ kind: 'retention-output' })
  expect(calls).toBe(3)
})
it('a source rebuild preserves previously spent local sizing corrections', async () => {
  const source = summarySource([{ role: 'user', content: '中'.repeat(50000) }])
  const attempts = { count: 0, staleRebuilds: 1, summarySizingCorrections: 2 }
  let calls = 0
  const model: ModelClient = { prepare: prepareTextFixture, async *stream() { calls++; throw Object.assign(Error('confirmed'), { code: 'CONTEXT_WINDOW_EXCEEDED' }) } }
  await expect(generateSelectedSummary(model, { ...source, attempts }, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 32000 })).rejects.toMatchObject({ kind: 'shrink-limit' })
  expect(attempts.count).toBe(1); expect(calls).toBe(1); expect(attempts.summarySizingCorrections).toBe(2)
})
it('the actual reduction transaction publishes no group when eight pages leave uncovered source', async () => {
  const session = createSession(), fixture = spyModel()
  append(session, { type: 'user/message', text: 'x'.repeat(600000) })
  append(session, { type: 'user/message', text: 'current request' })
  const before = JSON.stringify(session.events)
  const result = await createCompactionHarness({ model: fixture.model, config: { contextWindow: 100000, prune: false } }).compact(session)
  expect(result).toMatchObject({ compacted: false, blockedReason: 'call-limit' }); expect(fixture.requests).toHaveLength(8)
  expect(JSON.stringify(session.events)).toBe(before)
})
it('a deliberately omitted middle-fact fragment cannot publish a replacement', async () => {
  const session = createSession(); let removed = false
  append(session, { type: 'user/message', text: '中'.repeat(30000) + 'MIDDLE_FACT_MUST_ARRIVE' + '文'.repeat(30000) })
  append(session, { type: 'user/message', text: 'current request' })
  const before = JSON.stringify(session.events)
  const model: ModelClient = { async prepare(request) {
    if (String(request.messages.at(-1)?.content).includes('recorded-pages-v1')) {
      const parts = request.messages[0]!.content
      if (Array.isArray(parts)) { const index = parts.findIndex(part => part.type === 'text' && part.text.includes('MIDDLE_FACT_MUST_ARRIVE')); if (index >= 0) { parts.splice(index, 1); removed = true } }
    }
    return prepareTextFixture.call(this, request)
  }, async *stream() { yield { type: 'text/chunk', text: checkpointOfLength(600) }; yield { type: 'end' } } }
  const result = await createCompactionHarness({ model, config: { contextWindow: 32000, prune: false } }).compact(session)
  expect(removed).toBe(true); expect(result).toMatchObject({ compacted: false, blockedReason: 'source-unrepresentable' })
  expect(JSON.stringify(session.events)).toBe(before)
})
it.each([50, 200000])('preserves or blocks an indivisible image using actual prepared page facts (local image cost=%s)', async imageCost => {
  const image = { type: 'image' as const, image: { mediaType: 'image/png' as const, dataBase64: 'aGVsbG8=' } }, requests: LLMRequest[] = []
  const source = summarySource([{ role: 'user', content: [{ type: 'text', text: '中'.repeat(70000) }, image] }])
  // This client declares a local fixture cost, not a provider tokenizer or image price.
  const declare = (candidate: PreparedModelRequest): PreparedModelRequest => ({ ...candidate,
    measurement: { ...candidate.measurement, input: { ...candidate.measurement.input, uncertainties: [], components: { ...candidate.measurement.input.components,
      images: { ...candidate.measurement.input.components.images, heuristicTokens: candidate.measurement.input.components.images.imageCount ? imageCost : 0 } } } },
    withOutputCap: cap => declare(candidate.withOutputCap(cap)),
  })
  const model: ModelClient = { async prepare(request) { return declare(await prepareTextFixture.call(this, request)) }, async *stream(request) { requests.push(request); yield { type: 'text/chunk', text: checkpointOfLength(600) }; yield { type: 'end' } } }
  const result = generateSelectedSummary(model, source, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 100000 })
  if (imageCost === 50) await expect(result).resolves.toMatchObject({ groupIds: ['literal-0'] })
  else await expect(result).rejects.toMatchObject({ kind: 'shrink-limit' })
  const media = requests.flatMap(request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') : []))
  expect(media).toEqual(imageCost === 50 ? [image] : [])
  expect(requests.length).toBeLessThanOrEqual(8)
})
it('does not send a page whose final preparation cannot establish capacity', async () => {
  const source = summarySource([{ role: 'user', content: '中'.repeat(50000) }]); let sends = 0
  const model: ModelClient = { async prepare(request) {
    const prepared = await prepareTextFixture.call(this, request)
    if (!String(request.messages.at(-1)?.content).includes('recorded-pages-v1')) return prepared
    const unknown = (candidate: PreparedModelRequest): PreparedModelRequest => ({ ...candidate,
      measurement: { ...candidate.measurement, input: { ...candidate.measurement.input, uncertainties: ['image-token-cost'] } },
      withOutputCap: cap => unknown(candidate.withOutputCap(cap)),
    })
    return unknown(prepared)
  }, async *stream() { sends++; yield { type: 'text/chunk', text: checkpointOfLength(600) }; yield { type: 'end' } } }
  await expect(generateSelectedSummary(model, source, { maxTokens: 1024, minSummaryChars: 500, inherited: false }, { contextWindow: 32000 })).rejects.toMatchObject({ kind: 'opaque' })
  expect(sends).toBe(0)
})
it.each(['human', 'rules'] as const)('actual %s changes during paging preserve originals and stop after three stale rebuilds', async kind => {
  const session = createSession(); let calls = 0
  append(session, { type: 'user/message', text: '中'.repeat(50000) }); append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'current request' })
  const originals = JSON.stringify(session.events)
  const model: ModelClient = { prepare: prepareTextFixture, async *stream() {
    calls++
    if (kind === 'human') append(session, { type: 'agent/input/admitted', version: 1, inputId: `steer-${calls}`, text: `new human ${calls}`, delivery: 'steer', intent: 'user' })
    else append(session, { type: 'runtime/context', version: 1, sections: [{ name: 'rules', text: `current rules ${calls}` }] })
    yield { type: 'text/chunk', text: checkpointOfLength(600) }; yield { type: 'end' }
  } }
  const result = await createCompactionHarness({ model, config: { contextWindow: 100000, prune: false } }).compact(session)
  expect(result).toMatchObject({ compacted: false, blockedReason: 'unstable-input' }); expect(calls).toBe(4)
  expect(JSON.stringify(session.events.slice(0, 3))).toBe(originals)
  expect(session.events.some(event => event.type === 'compaction/replacement')).toBe(false)
  expect(JSON.stringify(session.events.at(-1))).toContain(kind === 'human' ? 'new human 4' : 'current rules 4')
})
