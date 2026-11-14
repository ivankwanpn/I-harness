import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { legacyFixture } from './legacy-fork-fixture.ts'
import { physicalBytes } from '../src/artifact/quota.ts'

async function canonicalInventory(directory: string) {
  const result: Record<string, string> = {}
  async function walk(path: string, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) await walk(join(path, entry.name), relative + '/')
      else if (!entry.name.startsWith('index.sqlite')) result[relative] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex')
    }
  }
  await walk(directory); return result
}
it('repairs corrupted main-index proof hints through passive owner maintenance without source or canonical writes', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation(), directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex')), db = new DatabaseSync(join(directory, 'index.sqlite'))
    try { db.prepare('UPDATE legacy_rows SET ref_id=?').run('ctx_' + 'f'.repeat(64)) } finally { db.close() }
    const before = await canonicalInventory(directory), sourceCalls = f.sourceCalls()
    const readable = await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)
    expect(readable.ref.id).toBe(f.visible.id)
    expect(readable.text).toContain('VISIBLE')
    expect(f.sourceCalls()).toBe(sourceCalls)
    expect(await canonicalInventory(directory)).toEqual(before)
    expect((await f.run(true)).kind).toBe('already-ready'); expect(f.sourceCalls()).toBe(sourceCalls)
    expect(await canonicalInventory(directory)).toEqual(before)
    const repaired = new DatabaseSync(join(directory, 'index.sqlite'))
    try { expect(repaired.prepare('SELECT DISTINCT ref_id FROM legacy_rows').all().map(row => row.ref_id)).toEqual([f.visible.id]) }
    finally { repaired.close() }
    expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).text).toContain('VISIBLE')
  } finally { await f.close() }
}, 15000)
it('refuses unfunded derived repair at the full budget and repairs after an actual budget raise', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready')
    const observation = await f.observation(), directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex')), full = await physicalBytes(directory)
    await f.service().configure({ maxDiskBytes: full })
    const db = new DatabaseSync(join(directory, 'index.sqlite')); try { db.exec('DELETE FROM legacy_rows') } finally { db.close() }
    const before = await canonicalInventory(directory)
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow(/quota/i)
    expect(await canonicalInventory(directory)).toEqual(before)
    await f.service().configure({ maxDiskBytes: full + 1024 * 1024 })
    expect((await f.service().searchLegacyObserved({ sessionId: 'target' }, { query: 'VISIBLE' }, observation)).hits.map(hit => hit.ref.id)).toEqual([f.visible.id])
  } finally { await f.close() }
}, 15000)
it('rebuilds a corrupt disposable SQLite file and cold proof hints from the original applied graph', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready'); await f.sourceClear(); await f.service().close()
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    await writeFile(join(directory, 'index.sqlite'), 'not a SQLite database')
    await f.reopen(); const before = await canonicalInventory(directory), sourceCalls = f.sourceCalls()
    expect((await f.run(true)).kind).toBe('already-ready'); expect(f.sourceCalls()).toBe(sourceCalls)
    expect(await canonicalInventory(directory)).toEqual(before)
    expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, await f.observation())).text).toContain('VISIBLE')
  } finally { await f.close() }
}, 15000)
