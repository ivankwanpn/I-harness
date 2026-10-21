import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createManagedSessionState, legacyPrefixDigest, projectConversation, toJSONL } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { buildSession } from '../../session-persistence/src/format/validation.ts'
import { parseHeader } from '../src/format.ts'
import { createJsonlBackend } from '../src/index.ts'
import { literalReady } from '../../core-session/test/fixtures/format11-seed.ts'

const evidence = resolve('../../.tmp/r4b-b1-20261022')
const pinnedProduct = '678af03dd54659e22dd5f941112c06ec9917e812'

it('uses the hash-pinned format10 execution reader to refuse ready, header-only and interrupted11 before repair', async () => {
  const sealed = resolve('../../.tmp/r4hc-02/g/node_modules'), copyRoot = join(evidence, 'predecessor')
  const copyMap = JSON.parse(await readFile(resolve('../../.tmp/r4hc-02/gateway-source-copy-map.json'), 'utf8')) as { pairs: { candidate: string; sha256: string }[] }
  const accepted = new Map(copyMap.pairs.map(row => [resolve(row.candidate).toLowerCase(), row.sha256]))
  const packages = ['@i-harness/core-session', '@i-harness/session-persistence', '@i-harness/session-persistence-jsonl', '@i-harness/fs-lock', '@i-harness/harness-home', '@i-harness/settings', '@i-harness/fs-watch', '@i-harness/telemetry', 'chokidar', 'readdirp']
  const receipts: { source: string; copy: string; sha256: string }[] = []
  async function provision(source: string, target: string) {
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('Pinned predecessor must contain regular files')
      const from = join(source, entry.name), to = join(target, entry.name)
      if (entry.isDirectory()) await provision(from, to)
      else {
        const bytes = await readFile(from), digest = createHash('sha256').update(bytes).digest('hex')
        expect(accepted.get(resolve(from).toLowerCase()), from).toBe(digest)
        await cp(from, to)
        expect(createHash('sha256').update(await readFile(to)).digest('hex')).toBe(digest)
        receipts.push({ source: from, copy: to, sha256: digest })
      }
    }
  }
  for (const name of packages) await provision(join(sealed, name), join(copyRoot, 'node_modules', name))
  await writeFile(join(copyRoot, 'test-copy-receipt.json'), JSON.stringify({ pinnedProduct, receipts }, null, 2))
  const store = join(copyRoot, 'fixtures')
  await mkdir(store, { recursive: true })
  const readyLines = toJSONL(literalReady).split('\n')
  readyLines[0] = JSON.stringify({ ...JSON.parse(readyLines[0]!), sessionId: 'literal11', createdAt: '2026-10-22T00:00:00.000Z' })
  const ready = readyLines.join('\n'), firstLF = ready.indexOf('\n')
  const cases = { ready, headerOnly: ready.slice(0, firstLF + 1), interrupted: ready.slice(0, firstLF + 24) }
  for (const [id, bytes] of Object.entries(cases)) await writeFile(join(store, `${id}.jsonl`), bytes)
  const runner = join(copyRoot, 'reader.mts')
  await writeFile(runner, `
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl';
import { createSessionCoordinator } from '@i-harness/session-persistence';
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session';
import { resolve } from 'node:path';
const root = resolve(import.meta.dir), counts = { fetch: 0, repair: 0, upgrade: 0 };
if (CURRENT_FORMAT_VERSION !== 10) throw Error('not the format10 predecessor');
for (const name of ['@i-harness/core-session','@i-harness/session-persistence','@i-harness/session-persistence-jsonl']) {
  if (!Bun.resolveSync(name, import.meta.dir).startsWith(root + '/node_modules') && !Bun.resolveSync(name, import.meta.dir).startsWith(root + '\\\\node_modules')) throw Error('escaped old graph');
}
globalThis.fetch = async () => { counts.fetch++; throw Error('network forbidden'); };
const backend = createJsonlBackend(process.argv[2]);
const actualRepair = backend.repair.bind(backend); backend.repair = async (...args) => { counts.repair++; return actualRepair(...args); };
const actualUpgrade = backend.upgradeSessionFormat.bind(backend); backend.upgradeSessionFormat = async (...args) => { counts.upgrade++; return actualUpgrade(...args); };
const coordinator = createSessionCoordinator(backend, { lock: { enabled: false } });
const refused = [];
try { for (const id of ['ready','headerOnly','interrupted']) {
  try { await coordinator.load(id); throw Error('accepted format11'); } catch (error) { if (!String(error).includes('newer than this build')) throw error; refused.push(id); }
} } finally { await coordinator.close(); }
console.log(JSON.stringify({ format: CURRENT_FORMAT_VERSION, refused, counts, providersLoaded: false, product: '${pinnedProduct}' }));
`)
  const result = JSON.parse(execFileSync('bun', [runner, store], { encoding: 'utf8' }).trim())
  expect(result).toEqual({ format: 10, refused: ['ready', 'headerOnly', 'interrupted'], counts: { fetch: 0, repair: 0, upgrade: 0 }, providersLoaded: false, product: pinnedProduct })
  for (const [id, bytes] of Object.entries(cases)) expect(await readFile(join(store, `${id}.jsonl`), 'utf8')).toBe(bytes)
  await writeFile(join(copyRoot, 'reader-receipt.json'), JSON.stringify(result, null, 2))
}, 30_000)

it('preserves reservation through parse→buildSession→managed view and reads10 without inventing ready evidence', async () => {
  const store = join(evidence, 'current-reader')
  await mkdir(store, { recursive: true })
  const current = toJSONL(literalReady), lines = current.split('\n')
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), sessionId: 'literal', createdAt: '2026-10-22T00:00:00.000Z' })
  await writeFile(join(store, 'literal.jsonl'), lines.join('\n'))
  const backend = createJsonlBackend(store), read = await backend.read('literal')
  const parsed = parseHeader(lines[0]!)
  const built = buildSession(parsed, read.events)
  expect(createManagedSessionState(built).view.header?.semanticSeed).toEqual(literalReady.header!.semanticSeed)
  expect(projectConversation(built).items[1]!.messages[1]!.content).toBe('seed exact')
  const journal = { version: 1, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 }
  await writeFile(join(store, 'old.jsonl'), JSON.stringify({ formatVersion: 10, sessionId: 'old', createdAt: 'old', journal }) + '\n')
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    const old = await coordinator.load('old')
    expect(old.session.header?.semanticSeed).toBeUndefined()
    expect(old.session.events).toEqual([])
    const document = await coordinator.openManagedDocument('literal')
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed', seqs: [3] })
    expect(document.view.events.slice(0, 3)).toEqual(literalReady.events)
    expect(document.view.header?.semanticSeed).toEqual(literalReady.header!.semanticSeed)
    const repair = vi.spyOn(backend, 'repair')
    for (const [id, text] of Object.entries({ headerOnly: lines[0]! + '\n', interrupted: lines[0]! + '\n' + lines[1]!.slice(0, 20) })) {
      await writeFile(join(store, `${id}.jsonl`), text)
      await expect(coordinator.openManagedDocument(id)).rejects.toThrow(/bootstrap-incomplete/)
      expect(await readFile(join(store, `${id}.jsonl`), 'utf8')).toBe(text)
    }
    expect(repair).not.toHaveBeenCalled()
  } finally { await coordinator.close() }
})
