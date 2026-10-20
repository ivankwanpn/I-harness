import { expect, it, vi } from 'vitest'
import { io, observeOpen, contentReads } from './integrity-io.ts'
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, open: observeOpen(fs.open) } })
import { resolve } from 'node:path'
import { fixture, commit, inventory, record } from './integrity-fixture.ts'
import type { ResultCodec } from '@i-harness/core-session'

it('rejects malformed UTF8 only after successful original Merkle proof and preserves valid UTF8 invalid JSON text', async () => {
  const f = await fixture('utf8-controls')
  try {
    const { readManagedResultPage } = await import('../src/result-page.ts'), { readVerifiedArtifactBytes } = await import('../src/artifact/reader.ts')
    const observed: unknown[] = []
    for (const codec of ['text-utf8-v1', 'json-utf8-v1'] as const) {
      const bytes = Buffer.from([0x61, 0xc0, 0xaf, 0x62]), saved = await commit(f.service, codec, bytes, codec); await f.reopen()
      io.reset(); expect(await readVerifiedArtifactBytes(resolve(f.directory(saved.ref), '../..'), f.directory(saved.ref), saved.ref, 0, bytes.length)).toEqual(bytes)
      expect(contentReads().some(event => event.path.endsWith('body') && event.actual === bytes.length)).toBe(true); io.stop()
      const before = await inventory(f.root); io.reset()
      const actual = await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref })
      expect(actual).toEqual({ kind: 'unavailable', reason: 'unavailable' }); expect(contentReads().filter(event => event.path.endsWith('body'))).toHaveLength(1)
      observed.push({ codec, actual, reads: [...io.reads], opens: [...io.opens] }); io.stop()
      expect(await inventory(f.root)).toEqual(before)
    }
    const jsonText = await commit(f.service, 'valid-utf8-invalid-json', Buffer.from('{ incomplete JSON syntax'), 'json-utf8-v1'); await f.reopen()
    expect(await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: jsonText.ref })).toMatchObject({ data: { text: '{ incomplete JSON syntax' }, eof: true })
    await record(`utf8-${f.root.split(/[\\/]/).at(-1)}`, observed)
  } finally { io.stop(); await f.close() }
})

const validLine = '{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'
it('calibrates separate native exec header/boundary/record I/O and rejects validly rooted malformed framing', async () => {
  const f = await fixture('exec-controls')
  try {
    const { readManagedResultPage } = await import('../src/result-page.ts')
    const goodBytes = Buffer.from('IHEXEC01\n' + validLine), good = await commit(f.service, 'exec-good', goodBytes, 'exec-frames-v1'); await f.reopen()
    io.reset(); const positive = await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: good.ref, maxBytes: 900 })
    expect(positive).toMatchObject({ frames: [{ channel: 'stdout', frame: 0, offset: 0, end: true, data: 'eA==' }], eof: true })
    const positiveReads = [...io.reads]
    expect(contentReads().filter(event => event.path.endsWith('body')).map(event => event.actual)).toEqual([goodBytes.length, goodBytes.length, goodBytes.length])
    expect(contentReads().filter(event => event.path.endsWith('index')).reduce((sum, event) => sum + event.actual, 0)).toBe(384); io.stop()
    const cases: [string, string][] = [
      ['header', 'IHEXEC00\n' + validLine], ['header-literal-backslash', 'IHEXEC01\\n' + validLine],
      ['no-lf', 'IHEXEC01\n' + validLine.trimEnd()], ['json-syntax', 'IHEXEC01\n{\n'],
      ['field-order', 'IHEXEC01\n' + validLine.replace('"channel":"stdout","frame":0', '"frame":0,"channel":"stdout"')],
      ['channel', 'IHEXEC01\n' + validLine.replace('stdout', 'other')], ['negative-frame', 'IHEXEC01\n' + validLine.replace('"frame":0', '"frame":-1')],
      ['unsafe-frame', 'IHEXEC01\n' + validLine.replace('"frame":0', '"frame":9007199254740992')],
      ['offset-overflow', 'IHEXEC01\n' + validLine.replace('"offset":0', '"offset":9007199254740991')],
      ['base64-unpadded', 'IHEXEC01\n' + validLine.replace('eA==', 'eA')], ['base64-pad-bits', 'IHEXEC01\n' + validLine.replace('eA==', 'eB==')],
      ['extra-key', 'IHEXEC01\n' + validLine.replace('"data":', '"extra":true,"data":')],
      ['raw-over32768', 'IHEXEC01\n' + validLine.replace('eA==', Buffer.alloc(32769).toString('base64'))],
      ['record-over45056', 'IHEXEC01\n' + ' '.repeat(45057) + '\n'],
    ]
    const observed: unknown[] = []
    for (const [name, body] of cases) {
      const bytes = Buffer.from(body), saved = await commit(f.service, name, bytes, 'exec-frames-v1'); await f.reopen()
      // Raw original binary read succeeds first: malformed codec bytes have valid proofs.
      let offset = 0; const verified: Buffer[] = []
      for (;;) {
        const page = await f.service.readResult({ sessionId: 'owner' }, { ref: saved.ref, offset })
        if (page.data.kind !== 'bytes') throw new Error('Expected raw verified exec bytes')
        verified.push(Buffer.from(page.data.base64, 'base64')); if (page.eof) break; offset = page.nextOffset!
      }
      expect(Buffer.concat(verified)).toEqual(bytes)
      const before = await inventory(f.root); io.reset()
      const actual = await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref })
      observed.push({ name, actual, reads: [...io.reads], opens: [...io.opens] }); io.stop()
      expect.soft(actual, name).toEqual({ kind: 'unavailable', reason: 'corrupt' }); expect.soft(await inventory(f.root), `${name}: no repair`).toEqual(before)
    }
    for (const cursor of [{ recordOffset: 10, sliceOffset: 0 }, { recordOffset: goodBytes.length + 1, sliceOffset: 0 }, { recordOffset: 0, sliceOffset: 1 }, { recordOffset: 9, sliceOffset: 2 }]) {
      expect(await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: good.ref, cursor })).toMatchObject({ kind: 'unavailable', reason: 'range' })
    }
    await record(`exec-${f.root.split(/[\\/]/).at(-1)}`, { positive, positiveReads, malformed: observed })
  } finally { io.stop(); await f.close() }
})

it('rejects unsafe/fractional public ranges before storage and preserves bounded UTF8 cursor/budget semantics', async () => {
  const f = await fixture('range-controls')
  try {
    const { readManagedResultPage, parseResultPageQuery } = await import('../src/result-page.ts')
    const bytes = Buffer.from('🙂'.repeat(1000)), saved = await commit(f.service, 'utf8', bytes); await f.reopen()
    const before = await inventory(f.root)
    const invalid = [
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(offset => ({ ref: saved.ref, offset })),
      ...[0, -1, 0.5, 32769, Number.MAX_SAFE_INTEGER + 1].map(maxBytes => ({ ref: saved.ref, maxBytes })),
      { ref: saved.ref, cursor: { recordOffset: 0, sliceOffset: 0 } },
    ]
    io.reset()
    for (const input of invalid) expect(parseResultPageQuery(input)).toBeUndefined()
    expect(io.opens).toHaveLength(0); expect(io.reads).toHaveLength(0); io.stop()
    expect(await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref, offset: 1 })).toMatchObject({ kind: 'unavailable', reason: 'range' })
    // Existing mapper prioritizes budget in the owner's combined range/budget error.
    expect(await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref, offset: bytes.length + 1 })).toMatchObject({ kind: 'unavailable', reason: 'budget' })
    expect(await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref, maxBytes: 1 })).toMatchObject({ kind: 'unavailable', reason: 'budget' })
    expect(await readManagedResultPage(f.service, { sessionId: 'owner' }, { ref: saved.ref, offset: bytes.length })).toMatchObject({ eof: true, data: { text: '' } })
    const page = await f.service.readResult({ sessionId: 'owner' }, { ref: saved.ref, maxBytes: 901 })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(901); expect(page.nextOffset! % 4).toBe(0)
    expect(await inventory(f.root)).toEqual(before)
    // Runtime dimensions reject unsafe arithmetic directly, without manufacturing giant files.
    const { dimensions } = await import('../src/artifact/index.ts')
    for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => dimensions(count)).toThrow(/overflow/)
    for (const codec of ['text-utf8-v1', 'exec-frames-v1'] as ResultCodec[]) {
      const forged = { ...saved.ref, codec, encodedBytes: Number.MAX_SAFE_INTEGER + 1 }
      expect(parseResultPageQuery({ ref: forged })).toBeUndefined()
    }
  } finally { io.stop(); await f.close() }
})
