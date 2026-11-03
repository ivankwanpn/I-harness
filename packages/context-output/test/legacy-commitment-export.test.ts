import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { canonicalJsonData } from '@i-harness/core-session'
import * as api from '../src/index.ts'
it('exports the actual five-field streamed commitment including a large descriptor and fractional expiry', () => {
  const ref = { id: 'ctx_' + 'a'.repeat(64), revision: 'b'.repeat(64), workspaceId: 'w', sessionId: 'creator', callId: 'call',
    label: 'large λ'.repeat(20000), bytes: 3, originalBytes: 5, complete: false, expiresAt: 1234.5,
    source: { sourceId: 'source', path: 'x'.repeat(80000), revision: 'rev', readonly: true } }
  const encoded = canonicalJsonData(ref)
  const expected = { refId: ref.id, revision: ref.revision, metadataDigest: createHash('sha256').update('ih.legacy-ref.metadata.v1\0' + encoded).digest('hex'), metadataEncodedBytes: Buffer.byteLength(encoded), expiresAt: 1234.5 }
  expect(api.captureLegacyRefCommitment(ref)).toEqual(expected)
  expect(api.captureLegacyRefCommitment({ ...ref, source: { ...ref.source, readonly: false } }).metadataDigest).not.toBe(expected.metadataDigest)
  expect(() => api.captureLegacyRefCommitment({ ...ref, label: undefined } as any)).toThrow()
})
