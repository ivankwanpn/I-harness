import { expect, it, vi } from 'vitest'
import { parseResultPageQuery, readManagedResultPage } from '../src/result-page.ts'
import type { ManagedArtifactRef } from '@i-harness/core-session'

const frame: ManagedArtifactRef = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1', encodedBytes: 1234, contentDigest: 'c'.repeat(64), completeness: 'complete' }
const catalog: ManagedArtifactRef = { ...frame, id: 'ctxv1_' + 'd'.repeat(64), codec: 'json-utf8-v1' }

it('accepts a closed exact catalog selector only for typed native frame queries', () => {
  const query = { ref: frame, viaCatalog: catalog, cursor: { recordOffset: 9, sliceOffset: 3 }, maxBytes: 4096 }
  expect(parseResultPageQuery(query)).toEqual(query)
  for (const bad of [
    { ...query, ref: catalog }, { ...query, viaCatalog: frame }, { ...query, viaCatalog: { ...catalog, id: frame.id } },
    { ...query, viaCatalog: { ...catalog, extra: true } }, { ...query, viaCatalog: null }, { ...query, offset: 0 },
    { ...query, cursor: { recordOffset: 0 } }, { ...query, extra: true },
  ]) expect(parseResultPageQuery(bad)).toBeUndefined()
})

it('rejects a malformed catalog selector before a storage reader can be invoked', async () => {
  const readResult = vi.fn(), readExecResult = vi.fn()
  const result = await readManagedResultPage({ readResult, readExecResult }, { sessionId: 'caller' }, { ref: frame, viaCatalog: { ...catalog, codec: 'text-utf8-v1' } } as never)
  expect(result).toEqual({ kind: 'unavailable', reason: 'range' })
  expect(readResult).not.toHaveBeenCalled(); expect(readExecResult).not.toHaveBeenCalled()
})
