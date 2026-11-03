import { expect, it, vi } from 'vitest'
const reads = vi.hoisted(() => ({ active: false, bodies: [] as string[], pages: [] as number[] }))
vi.mock('../src/artifact/reader.ts', async original => {
  const reader = await original<typeof import('../src/artifact/reader.ts')>()
  return { ...reader, readVerifiedArtifactBytes: async (...args: Parameters<typeof reader.readVerifiedArtifactBytes>) => {
    if (reads.active) { reads.bodies.push(args[1]); reads.pages.push(args[4]) }
    return reader.readVerifiedArtifactBytes(...args)
  } }
})
import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { ResultDependency } from '@i-harness/core-session'
import { readDependencyCatalog } from '../src/artifact/dependency-catalog.ts'
import { structureEvidence } from './structure-evidence.ts'
const evidence = resolve(structureEvidence(resolve(import.meta.dirname, '../../../.tmp/context-parallel-artifact-20261023')), 'catalog')
await mkdir(evidence, { recursive: true }); process.env.IH_CONFIG_DIR = resolve(evidence, 'config')
const { createContextOutputService } = await import('../src/index.ts')
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
async function fixture(body: string | Buffer) {
  const root = await mkdtemp(resolve(evidence, 'body-')), service = createContextOutputService({ root, workspaceId: 'catalog' })
  const scope = service.registerResultScope({ operationId: 'catalog', sessionId: 'owner', callId: 'catalog' }, () => true)
  const sink = await service.beginResult(scope, 'json-utf8-v1'), bytes = Buffer.from(body)
  for (let offset = 0; offset < bytes.length; offset += 32768) await sink.write(bytes.subarray(offset, offset + 32768))
  const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Catalog fixture refused')
  const owned = resolve(root, 'context-output', hash('catalog')), directory = resolve(owned, 'managed-v1', saved.ref.id)
  return { root: owned, service, directory, ref: saved.ref }
}

it('streams more than 100 real catalog entries across pages with Unicode, arbitrary key order and an independent small JSON oracle', async () => {
  const entries: ResultDependency[] = Array.from({ length: 300 }, (_, n) => ({ kind: 'exec-frames', sourceId: `${n}-漢🙂-${'x'.repeat(100)}`, retention: { kind: 'unavailable', reason: 'quota', observedEncodedBytes: n } }))
  const body = ` { "entries" : ${JSON.stringify(entries).replaceAll('漢', '\\u6f22')}, "kind" : "result-dependencies", "version" : 1 } \n`
  const oracle = JSON.parse(body), f = await fixture(body), actual: ResultDependency[] = []
  reads.bodies = []; reads.pages = []; reads.active = true
  try {
    expect(await readDependencyCatalog(f.root, f.directory, f.ref, (entry, ordinal) => { expect(ordinal).toBe(actual.length); actual.push(entry) }, 300)).toBe(300)
    expect(actual).toEqual(oracle.entries)
    expect(reads.pages.length).toBeGreaterThan(1); expect(Math.max(...reads.pages)).toBeLessThanOrEqual(32768)
    expect(new Set(reads.bodies)).toEqual(new Set([f.directory]))
    await expect(readDependencyCatalog(f.root, f.directory, f.ref, () => {}, 299)).rejects.toThrow()
  } finally { reads.active = false; await f.service.close() }
})

it('reads retained reference metadata without requiring or reading the member body', async () => {
  const member = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1', encodedBytes: 72, contentDigest: 'c'.repeat(64), completeness: 'complete' }
  const body = JSON.stringify({ version: 1, kind: 'result-dependencies', entries: [{ kind: 'exec-frames', sourceId: 'retained', retention: { kind: 'artifact', ref: member } }] })
  const f = await fixture(body), seen: ResultDependency[] = []
  reads.bodies = []; reads.pages = []; reads.active = true
  try {
    expect(await readDependencyCatalog(f.root, f.directory, f.ref, e => { seen.push(e) }, 1)).toBe(1)
    expect(seen).toEqual(JSON.parse(body).entries)
    expect(new Set(reads.bodies)).toEqual(new Set([f.directory]))
  } finally { reads.active = false; await f.service.close() }
})

it('preserves distinct escaped surrogate sourceIds without collapsing their uniqueness keys during UTF8 hashing', async () => {
  const body = '{"version":1,"kind":"result-dependencies","entries":[' +
    '{"kind":"exec-frames","sourceId":"\\ud800","retention":{"kind":"unavailable","reason":"quota"}},' +
    '{"kind":"exec-frames","sourceId":"\\ud801","retention":{"kind":"unavailable","reason":"quota"}}]}'
  const f = await fixture(body), seen: string[] = []
  try {
    expect(await readDependencyCatalog(f.root, f.directory, f.ref, e => { seen.push(e.sourceId) }, 2)).toBe(2)
    expect(seen).toEqual(JSON.parse(body).entries.map((e: ResultDependency) => e.sourceId))
  } finally { await f.service.close() }
})

const entry = '{"kind":"exec-frames","sourceId":"one","retention":{"kind":"unavailable","reason":"quota"}}'
it.each([
  ['duplicate root key', '{"version":1,"version":1,"kind":"result-dependencies","entries":[' + entry + ']}'],
  ['duplicate entry key', '{"version":1,"kind":"result-dependencies","entries":[' + entry.replace('"sourceId":"one"', '"sourceId":"one","sourceId":"two"') + ']}'],
  ['escaped duplicate entry key', '{"version":1,"kind":"result-dependencies","entries":[' + entry.replace('"sourceId":"one"', '"sourceId":"one","source\\u0049d":"two"') + ']}'],
  ['duplicate retention key', '{"version":1,"kind":"result-dependencies","entries":[' + entry.replace('"reason":"quota"', '"reason":"quota","reason":"quota"') + ']}'],
  ['duplicate source identity', '{"version":1,"kind":"result-dependencies","entries":[' + entry + ',' + entry + ']}'],
  ['extra root key', '{"version":1,"kind":"result-dependencies","extra":true,"entries":[' + entry + ']}'],
  ['invalid refusal', '{"version":1,"kind":"result-dependencies","entries":[' + entry.replace('"quota"', '"unknown"') + ']}'],
  ['extra final root key', '{"version":1,"kind":"result-dependencies","entries":[' + entry + '],"extra":0}'],
  ['trailing bytes', '{"version":1,"kind":"result-dependencies","entries":[' + entry + ']} trailing'],
  ['trailing comma', '{"version":1,"kind":"result-dependencies","entries":[' + entry + ',]}'],
  ['oversized descriptor whitespace', '{"version":1,"kind":"result-dependencies","entries":[' + entry.replace('"sourceId"', ' '.repeat(8192) + '"sourceId"') + ']}'],
])('refuses %s', async (_name, body) => {
  const f = await fixture(body)
  try { await expect(readDependencyCatalog(f.root, f.directory, f.ref, () => {})).rejects.toThrow() }
  finally { await f.service.close() }
})

it('decodes valid split Unicode and refuses malformed UTF8 inside a sourceId across an actual page boundary', async () => {
  const root = Buffer.from('{"version":1,"kind":"result-dependencies","entries":['), item = Buffer.from('{"kind":"exec-frames","sourceId":"')
  const padding = Buffer.alloc(32767 - root.length - item.length, 32), end = Buffer.from('","retention":{"kind":"unavailable","reason":"quota"}}]}')
  for (const [source, valid] of [[Buffer.from('🙂漢'), true], [Buffer.from([0xf0, 0x9f, 0x28, 0x80]), false]] as const) {
    const f = await fixture(Buffer.concat([root, padding, item, source, end])), seen: string[] = []
    try {
      if (valid) { expect(await readDependencyCatalog(f.root, f.directory, f.ref, e => { seen.push(e.sourceId) }, 1)).toBe(1); expect(seen).toEqual(['🙂漢']) }
      else await expect(readDependencyCatalog(f.root, f.directory, f.ref, () => {})).rejects.toThrow()
    } finally { await f.service.close() }
  }
})
