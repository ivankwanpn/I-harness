import { expect, it, vi } from 'vitest'
import { io, observeOpen, contentReads } from './integrity-io.ts'
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, open: observeOpen(fs.open) } })
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { literalVectors } from './integrity-vectors.ts'
import { fixture, commit, hash, inventory, record, vectorBody } from './integrity-fixture.ts'

it.each(literalVectors)('matches independent literal header/heap/manifest bytes and complete cold pages for $size bytes', async vector => {
  const f = await fixture(`vector-${vector.size}`)
  try {
    // All fixed expected bytes and digests were pinned before invoking this writer.
    const bytes = vectorBody(vector.size)
    expect(hash(bytes)).toBe(vector.contentDigest)
    const expectedIndex = Buffer.from(vector.header + vector.heap.join(''), 'hex')
    expect(expectedIndex.length).toBe(vector.indexBytes); expect(hash(expectedIndex)).toBe(vector.indexDigest)
    expect(hash(vector.manifest)).toBe(vector.revision)
    const saved = await commit(f.service, `vector-${vector.size}`, bytes)
    expect(saved.ref).toMatchObject({ contentDigest: vector.contentDigest, revision: vector.revision, encodedBytes: vector.size, codec: 'text-utf8-v1', completeness: 'complete' })
    expect(await readFile(resolve(f.directory(saved.ref), 'index'))).toEqual(expectedIndex)
    expect(await readFile(resolve(f.directory(saved.ref), 'manifest.json'), 'utf8')).toBe(vector.manifest)
    await f.reopen(); const before = await inventory(f.root), pages: unknown[] = [], native: unknown[] = []
    let offset = 0; const reconstructed: Buffer[] = []
    for (;;) {
      io.reset(); const page = await f.service.readResult({ sessionId: 'owner' }, { ref: saved.ref, offset })
      const reads = contentReads(); native.push({ offset, reads: [...io.reads], opens: [...io.opens] }); io.stop()
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
      expect(page.data.kind).toBe('text'); if (page.data.kind !== 'text') throw new Error('Expected literal UTF8 view')
      const output = Buffer.from(page.data.text); expect(output).toEqual(bytes.subarray(offset, offset + output.length))
      const verificationEnd = offset + Math.min(vector.size - offset, 32771)
      const ordinals: number[] = []
      for (let ordinal = Math.floor(offset / 65536); ordinal * 65536 < verificationEnd; ordinal++) ordinals.push(ordinal)
      const expectedBody = ordinals.reduce((sum, ordinal) => sum + Math.min(65536, vector.size - ordinal * 65536), 0)
      const depth = Math.log2((vector.heap.length + 1) / 2)
      const indexBytes = vector.size === 0 ? 128 : 96 + ordinals.length * (32 + depth * 32)
      expect(reads.filter(event => event.path.endsWith('body')).reduce((sum, event) => sum + event.actual, 0)).toBe(expectedBody)
      expect(reads.filter(event => event.path.endsWith('index')).reduce((sum, event) => sum + event.actual, 0)).toBe(indexBytes)
      expect(reads.filter(event => event.path.endsWith('body')).map(event => event.offset)).toEqual(ordinals.map(ordinal => ordinal * 65536))
      pages.push(page); reconstructed.push(output); offset += output.length
      if (page.eof) break
      expect(page.nextOffset).toBe(offset); expect(output.length).toBeGreaterThan(0)
    }
    expect(Buffer.concat(reconstructed)).toEqual(bytes); expect(offset).toBe(vector.size)
    expect(await inventory(f.root)).toEqual(before)
    await record(`vector-${f.root.split(/[\\/]/).at(-1)}`, { vector, pages, native, unchangedInventory: before })
  } finally { io.stop(); await f.close() }
})

it('calibrates both touched chunks for maxBytes+3 across a boundary and joins actual short reads', async () => {
  const f = await fixture('native-io')
  try {
    const bytes = vectorBody(131073), saved = await commit(f.service, 'native', bytes); await f.reopen()
    const events: unknown[] = []
    for (const short of [false, true]) {
      io.reset()
      if (short) io.beforeRead = async (path, _position, length) => /[\\/](body|index)$/.test(path) ? Math.min(length, 8191) : undefined
      const page = await f.service.readResult({ sessionId: 'owner' }, { ref: saved.ref, offset: 65535, maxBytes: 900 })
      expect(page.data.kind).toBe('text'); if (page.data.kind !== 'text') throw new Error('Expected text')
      expect(page.data.text.startsWith('AB')).toBe(true)
      const reads = contentReads(), body = reads.filter(event => event.path.endsWith('body')), index = reads.filter(event => event.path.endsWith('index'))
      expect(body.reduce((sum, event) => sum + event.actual, 0)).toBe(131072)
      expect(index.reduce((sum, event) => sum + event.actual, 0)).toBe(288)
      expect(body.length).toBe(short ? 18 : 2); expect(index.length).toBe(8)
      events.push({ short, page, reads: [...io.reads], opens: [...io.opens] }); io.stop()
    }
    io.reset(); io.beforeRead = async path => path.endsWith('body') ? 0 : undefined
    await expect(f.service.readResult({ sessionId: 'owner' }, { ref: saved.ref })).rejects.toThrow(/short read/)
    expect(contentReads().some(event => event.actual === 0 && event.requested > 0)).toBe(true)
    events.push({ prematureEOF: [...io.reads] }); io.stop()
    await record(`native-io-${f.root.split(/[\\/]/).at(-1)}`, events)
  } finally { io.stop(); await f.close() }
})
