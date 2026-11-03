import { expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPages, walkPages, rowProof } from '../src/legacy/fork-pages.ts'
import { checkPage, checkRoot, recordHash } from '../src/legacy/fork-codec.ts'
import type { LegacyBinding, LegacyPage, LegacyRow } from '../src/index.ts'

const binding: LegacyBinding = { workspaceId: 'w', invocation: { version: 1, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-25T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, manifestDigest: 'b'.repeat(64), sourceSessionId: 'source', targetSessionId: 'target', targetDocumentId: 'target', semanticSeedDigest: 'c'.repeat(64), sourceObservationDigest: 'd'.repeat(64), selection: { kind: 'completed' }, targetSourceDigest: 'e'.repeat(64), turnDomainDigest: 'f'.repeat(64), totalTurns: 1, unframedPrefix: false }
it('closes leaves at the encoded byte limit before100 rows, proves addressed rows, and refuses trailing/missing data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ih-l1-page-')), pages = new Map<string, LegacyPage>(); await mkdir(join(directory, 'pages'))
  async function* rows() {
    for (let seq = 0; seq < 101; seq++) yield { refId: 'ctx_' + 'a'.repeat(64), revision: 'b'.repeat(64), metadataDigest: 'c'.repeat(64), metadataEncodedBytes: 1234, expiresAt: 2_000_000_000_000,
      original: { sessionId: 's'.repeat(1024), seq, part: 'context/result-ref.ref' as const }, extent: { kind: 'framed' as const, first: 1, last: 1 }, anchor: { kind: 'seed-group' as const, manifestSeq: 0 as const, ordinal: 0 },
      via: { sessionId: 'p'.repeat(1024), operationId: 'op', manifestDigest: 'd'.repeat(64), planDigest: 'e'.repeat(64), rowOrdinal: seq } } satisfies LegacyRow
  }
  const graph = await buildPages(binding, rows(), async (name, page) => { pages.set(name, page); await writeFile(join(directory, 'pages', name), JSON.stringify(page)) })
  const leaves = [...pages.values()].filter(page => page.kind === 'legacy-fork-leaf')
  expect(leaves.length).toBeGreaterThan(2)
  for (const page of leaves) { expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536); expect(page.rows.length).toBeLessThan(100) }
  const root = checkRoot({ version: 1, kind: 'legacy-fork-plan', binding, ...graph, distinctRefCount: 1 }), observed: number[] = []
  for await (const row of walkPages(directory, root, () => {})) observed.push(row.original.seq)
  expect(observed).toEqual(Array.from({ length: 101 }, (_, i) => i)); expect((await rowProof(directory, root, 100, () => {})).original.seq).toBe(100)
  await writeFile(join(directory, 'pages', '0-999.json'), '{}')
  await expect((async () => { for await (const _ of walkPages(directory, root, () => {})) { /* exact EOF */ } })()).rejects.toThrow()
  const leafName = [...pages.keys()].find(name => name.startsWith('0-'))!, bytes = await readFile(join(directory, 'pages', leafName))
  await writeFile(join(directory, 'pages', leafName), bytes.subarray(0, bytes.length - 1))
  await expect(rowProof(directory, root, 0, () => {})).rejects.toThrow()
})
it('rejects mixed directory levels, extra fields and unsafe ranges', () => {
  const page = { version: 1, kind: 'legacy-fork-directory', bindingDigest: recordHash('binding', binding), level: 2, children: [{ digest: 'a'.repeat(64), firstRow: 0, rows: 1, level: 1 }, { digest: 'b'.repeat(64), firstRow: 1, rows: 1, level: 0 }] }
  expect(() => checkPage(page, binding)).toThrow()
  expect(() => checkRoot({ version: 1, kind: 'legacy-fork-plan', binding, observationCount: 0, distinctRefCount: 0, pages: null, extra: true })).toThrow()
})
it('rejects an explicitly null immediate via', () => {
  const row = { refId: 'ctx_' + 'a'.repeat(64), revision: 'b'.repeat(64), metadataDigest: 'c'.repeat(64), metadataEncodedBytes: 1, expiresAt: 2_000_000_000_000,
    original: { sessionId: 'source', seq: 1, part: 'context/result-ref.ref' }, extent: { kind: 'framed', first: 1, last: 1 }, anchor: { kind: 'seed-group', manifestSeq: 0, ordinal: 0 }, via: null }
  expect(() => checkPage({ version: 1, kind: 'legacy-fork-leaf', bindingDigest: recordHash('binding', binding), firstRow: 0, rows: [row] }, binding)).toThrow()
})
it('keeps V2 selected result anchors in a distinct versioned graph',()=>{
 const selectedResults={version:1 as const,rows:2,pages:1,digest:'1'.repeat(64)},v2={...binding,selectedResults},row={refId:'ctx_'+'a'.repeat(64),revision:'b'.repeat(64),metadataDigest:'c'.repeat(64),metadataEncodedBytes:1,expiresAt:2_000_000_000_000,original:{sessionId:'source',seq:1,part:'context/result-ref.ref'},extent:{kind:'framed',first:1,last:1},anchor:{kind:'seed-result',manifestSeq:0,pageOrdinal:0,rowOrdinal:1}}
 const page={version:2,kind:'legacy-fork-leaf',bindingDigest:recordHash('binding',v2,2),firstRow:0,rows:[row]}
 expect(checkPage(page,v2,undefined,2)).toEqual(page)
 expect(recordHash('binding',v2,2)).not.toBe(recordHash('binding',v2))
 expect(checkRoot({version:2,kind:'legacy-fork-plan',binding:v2,observationCount:0,distinctRefCount:0,pages:null}).version).toBe(2)
 expect(()=>checkPage({...page,version:1},v2,undefined,2)).toThrow()
 expect(()=>checkPage({...page,rows:[{...row,anchor:{kind:'seed-group',manifestSeq:0,ordinal:0}}]},v2,undefined,2)).toThrow()
 expect(()=>checkPage({...page,rows:[{...row,anchor:{...row.anchor,rowOrdinal:2}}]},v2,undefined,2)).toThrow()
 expect(()=>checkRoot({version:1,kind:'legacy-fork-plan',binding:v2,observationCount:0,distinctRefCount:0,pages:null})).toThrow()
})
it('writes and proves V2 pages without changing the V1 hash family',async()=>{
 const directory=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-v2-page-'));await mkdir(join(directory,'pages'))
 const v2={...binding,selectedResults:{version:1 as const,rows:2,pages:1,digest:'1'.repeat(64)}},row={refId:'ctx_'+'a'.repeat(64),revision:'b'.repeat(64),metadataDigest:'c'.repeat(64),metadataEncodedBytes:1,expiresAt:2_000_000_000_000,original:{sessionId:'source',seq:1,part:'context/result-ref.ref' as const},extent:{kind:'framed' as const,first:1,last:1},anchor:{kind:'seed-result' as const,manifestSeq:0 as const,pageOrdinal:0,rowOrdinal:1}}
 async function* rows(){yield row}
 const graph=await buildPages(v2,rows(),async(name,page)=>writeFile(join(directory,'pages',name),JSON.stringify(page)),2),root=checkRoot({version:2,kind:'legacy-fork-plan',binding:v2,...graph,distinctRefCount:1})
 expect(await rowProof(directory,root,0,()=>{})).toEqual(row)
 const result=[];for await(const item of walkPages(directory,root,()=>{}))result.push(item);expect(result).toEqual([row])
})
