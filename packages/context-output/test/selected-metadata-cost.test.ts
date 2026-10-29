import { it, expect, vi, type MockInstance } from 'vitest'
const io = vi.hoisted(() => ({ enabled: false, pages: 0, inventories: 0, sync: 0, bodies: 0, writes: 0, failDirectoryClose: 0, directory: undefined as object | undefined, directoryAttempts: [] as object[] }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => { if (io.enabled) io.inventories++; return fs.readdir(...args) },
    opendir: async (...args: Parameters<typeof fs.opendir>) => {
      if (io.enabled) io.inventories++; const handle = await fs.opendir(...args)
      return new Proxy(handle, { get(target, key) {
        if (key === 'close') return async () => { if (io.failDirectoryClose || io.directory === target) { io.directory = target; io.directoryAttempts.push(target); if (io.failDirectoryClose > 0) { io.failDirectoryClose--; throw Error('directory close debt') } }; return target.close() }
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
      } })
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const path = String(args[0]); if (io.enabled) { if (/[\\/]pages[\\/].*\.json$/.test(path)) io.pages++; if (/[\\/]blobs[\\/]/.test(path)) io.bodies++; if (args[1] !== 'r') io.writes++ }
      const handle = await fs.open(...args)
      return new Proxy(handle, { get(target, key) { if (key === 'sync') return async () => { if (io.enabled) io.sync++; return target.sync() }; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value } })
    },
  }
})
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ContextStore } from '../src/store.ts'
import { acquireSelectedMetadata } from '../src/service.ts'
import { recordHash, appliedFor } from '../src/legacy/fork-codec.ts'
import { fundSlots, revokedTuple } from '../src/legacy/fork-disposition.ts'
import { legacyFixture } from './legacy-fork-fixture.ts'
const directory = (f: Awaited<ReturnType<typeof legacyFixture>>) => join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'legacy-fork-v1', recordHash('binding', f.request.invocation))

it.each([5, 101])('qualifies %s real duplicate observations with only three graph passes and linear canonical work', async rows => {
  const f = await legacyFixture({ observations: rows }); let canonical: MockInstance<ContextStore['canonicalRef']> | undefined
  try {
    expect((await f.run()).kind).toBe('ready'); const observation = await f.observation(), pages = (await readdir(join(directory(f), 'pages'))).length
    canonical = vi.spyOn(ContextStore.prototype, 'canonicalRef'); io.pages = io.inventories = io.sync = io.bodies = io.writes = 0; io.enabled = true
    const owner = await acquireSelectedMetadata(f.service(), observation), iterator = owner.reader.legacy()[Symbol.asyncIterator]()
    for (let n = 0; n < 3; n++) expect((await iterator.next()).done).toBe(false)
    expect(canonical.mock.calls.length).toBeLessThanOrEqual(3 * rows); expect(io.pages).toBeLessThanOrEqual(3 * pages)
    let emitted = 3; while (!(await iterator.next()).done) emitted++
    expect(emitted).toBe(rows); expect(canonical.mock.calls.length).toBe(3 * rows); expect(io.pages).toBe(3 * pages); expect(io.inventories).toBeLessThanOrEqual(12)
    console.log(JSON.stringify({ control: 'selected metadata constant passes', rows, pages, canonical: canonical.mock.calls.length, pageReads: io.pages, inventories: io.inventories }))
    const before = { pages: io.pages, inventories: io.inventories, canonical: canonical.mock.calls.length }; expect((await iterator.next()).done).toBe(true)
    expect({ pages: io.pages, inventories: io.inventories, canonical: canonical.mock.calls.length }).toEqual(before)
    expect([io.sync, io.bodies, io.writes]).toEqual([0, 0, 0]); io.enabled = false; await owner.close()
  } finally { io.enabled = false; canonical?.mockRestore(); await f.close() }
}, 15000)

it('expires both retained assertions after complete enumeration and never revives reader A', async () => {
  const f = await legacyFixture(); let clock: ReturnType<typeof vi.spyOn> | undefined
  try {
    expect((await f.run()).kind).toBe('ready'); const owner = await acquireSelectedMetadata(f.service(), await f.observation()), iterator = owner.reader.legacy()[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false); expect((await iterator.next()).done).toBe(true); owner.assertCurrent(); owner.reader.assertCurrent()
    clock = vi.spyOn(Date, 'now').mockReturnValue(f.visible.expiresAt + 1); expect(() => owner.reader.assertCurrent()).toThrow(); expect(() => owner.assertCurrent()).toThrow()
    clock.mockRestore(); clock = undefined; expect(() => owner.assertCurrent()).toThrow(); await owner.close()
  } finally { clock?.mockRestore(); await f.close() }
})

it('refuses an otherwise self-consistent original plan with a false distinct reference count', async () => {
  const f = await legacyFixture({ observations: 2 })
  try {
    expect((await f.run()).kind).toBe('ready'); const folder = directory(f), paths = ['plan.json', 'applied.json', 'revoke.0', 'revoke.1'].map(name => join(folder, name)), saved = await Promise.all(paths.map(path => readFile(path)))
    const root = JSON.parse(saved[0]!.toString()); root.distinctRefCount = 2
    try {
      await writeFile(paths[0]!, JSON.stringify(root)); await writeFile(paths[1]!, JSON.stringify(appliedFor(root))); await unlink(paths[2]!); await unlink(paths[3]!)
      await fundSlots(join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex')), join(folder, 'revoke'), revokedTuple(root), 64 * 1024 * 1024, () => {})
      await expect(acquireSelectedMetadata(f.service(), await f.observation())).rejects.toThrow()
    } finally { await Promise.all(paths.map((path, i) => writeFile(path, saved[i]!))) }
  } finally { await f.close() }
})

it('latches source revocation before an unrelated clear sweeps its expired canonical authority', async () => {
  const f = await legacyFixture(); let clock: ReturnType<typeof vi.spyOn> | undefined
  try {
    expect((await f.run()).kind).toBe('ready'); const owner = await acquireSelectedMetadata(f.service(), await f.observation())
    clock = vi.spyOn(Date, 'now').mockReturnValue(f.visible.expiresAt + 1); await f.service().clear('unrelated')
    clock.mockRestore(); clock = undefined; expect(() => owner.assertCurrent()).toThrow(); await owner.close()
  } finally { clock?.mockRestore(); await f.close() }
})

it('uses a loaded original leaf snapshot but refuses its changed bytes at final qualification', async () => {
  const f = await legacyFixture({ observations: 3 })
  try {
    expect((await f.run()).kind).toBe('ready'); const owner = await acquireSelectedMetadata(f.service(), await f.observation()), iterator = owner.reader.legacy()[Symbol.asyncIterator](), path = join(directory(f), 'pages', '0-0.json'), saved = await readFile(path)
    try {
      expect((await iterator.next()).done).toBe(false); await writeFile(path, '{}')
      expect((await iterator.next()).done).toBe(false); expect((await iterator.next()).done).toBe(false)
      await expect(iterator.next()).rejects.toThrow(); expect(() => owner.assertCurrent()).toThrow()
    } finally { await writeFile(path, saved); await owner.close() }
  } finally { await f.close() }
})

it.each(['foreign.pending', '0-0.json.foreign.pending'])('refuses inserted page inventory entry %s before EOF qualification', async name => {
  const f = await legacyFixture({ observations: 2 })
  try {
    expect((await f.run()).kind).toBe('ready'); const owner = await acquireSelectedMetadata(f.service(), await f.observation()), iterator = owner.reader.legacy()[Symbol.asyncIterator](), path = join(directory(f), 'pages', name)
    expect((await iterator.next()).done).toBe(false); await writeFile(path, '')
    try { expect((await iterator.next()).done).toBe(false); await expect(iterator.next()).rejects.toThrow() }
    finally { await unlink(path); await owner.close() }
  } finally { await f.close() }
})

it('rechecks an earlier emitted canonical owner during final qualification', async () => {
  const f = await legacyFixture({ distinct: 2 })
  try {
    expect((await f.run()).kind).toBe('ready'); const owner = await acquireSelectedMetadata(f.service(), await f.observation()), iterator = owner.reader.legacy()[Symbol.asyncIterator](), path = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'owners', f.visible.id + '.json'), saved = await readFile(path)
    try {
      expect((await iterator.next()).done).toBe(false); await writeFile(path, JSON.stringify(JSON.parse(saved.toString()).filter((id: string) => id !== 'target')))
      expect((await iterator.next()).done).toBe(false); await expect(iterator.next()).rejects.toThrow('membership')
    } finally { await writeFile(path, saved); await owner.close() }
  } finally { await f.close() }
})

it('early return closes the original iterator without final scanning or success qualification', async () => {
  const f = await legacyFixture({ observations: 5 }); const canonical = vi.spyOn(ContextStore.prototype, 'canonicalRef')
  try {
    expect((await f.run()).kind).toBe('ready'); canonical.mockClear(); const owner = await acquireSelectedMetadata(f.service(), await f.observation()), iterator = owner.reader.legacy()[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false); const calls = canonical.mock.calls.length; await iterator.return!(); await iterator.return!()
    expect(canonical.mock.calls.length).toBe(calls); expect(calls).toBe(6); expect(() => owner.assertCurrent()).toThrow(); await expect(iterator.next()).rejects.toThrow(); await owner.close()
  } finally { canonical.mockRestore(); await f.close() }
})

it('keeps the same original directory and store after acquisition cleanup and service close fail', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready'); const observation = await f.observation(); io.directoryAttempts = []; io.directory = undefined; io.failDirectoryClose = 3
    await expect(acquireSelectedMetadata(f.service(), observation)).rejects.toThrow('cleanup unresolved')
    await expect(f.service().close()).rejects.toThrow(); expect(io.directoryAttempts.length).toBe(3)
    const original = io.directoryAttempts[0]; await f.service().close(); expect(io.directoryAttempts.length).toBe(4); expect(io.directoryAttempts.every(handle => handle === original)).toBe(true)
  } finally { io.failDirectoryClose = 0; io.directory = undefined; await f.close() }
})

it('cannot return qualified EOF while the original final inventory close has debt', async () => {
  const f = await legacyFixture()
  try {
    expect((await f.run()).kind).toBe('ready'); const owner = await acquireSelectedMetadata(f.service(), await f.observation()), iterator = owner.reader.legacy()[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false); io.directoryAttempts = []; io.directory = undefined; io.failDirectoryClose = 1
    await expect(iterator.next()).rejects.toThrow('directory close debt'); expect(() => owner.assertCurrent()).toThrow()
    await owner.close(); expect(io.directoryAttempts.length).toBe(2); expect(io.directoryAttempts[0]).toBe(io.directoryAttempts[1])
  } finally { io.failDirectoryClose = 0; io.directory = undefined; await f.close() }
})

it('refuses a changed original root between yields without adopting a replacement plan', async () => {
  const f = await legacyFixture({ observations: 2 })
  try {
    expect((await f.run()).kind).toBe('ready'); const owner = await acquireSelectedMetadata(f.service(), await f.observation()), iterator = owner.reader.legacy()[Symbol.asyncIterator](), path = join(directory(f), 'plan.json'), saved = await readFile(path)
    try { expect((await iterator.next()).done).toBe(false); await writeFile(path, '{}'); await expect(iterator.next()).rejects.toThrow(); await writeFile(path, saved); expect(() => owner.assertCurrent()).toThrow() }
    finally { await writeFile(path, saved); await owner.close() }
  } finally { await f.close() }
})

it('refuses genuine managed source revocation between emitted rows', async () => {
  const f = await legacyFixture({ observations: 2 })
  try {
    expect((await f.run()).kind).toBe('ready'); const owner = await acquireSelectedMetadata(f.service(), await f.observation()), iterator = owner.reader.legacy()[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false); (await f.coordinator().openManagedDocument('target')).revokeNewWork(); expect(() => owner.assertCurrent()).toThrow(); await expect(iterator.next()).rejects.toThrow(); await owner.close()
  } finally { await f.close() }
})

it('refuses inconsistent commitments for a repeated ref without deduplicating valid observations', async () => {
  const f = await legacyFixture({ observations: 2 })
  try {
    expect((await f.run()).kind).toBe('ready'); const folder = directory(f), paths = ['plan.json', 'applied.json', 'revoke.0', 'revoke.1', 'pages/0-0.json'].map(name => join(folder, name)), saved = await Promise.all(paths.map(path => readFile(path))), root = JSON.parse(saved[0]!.toString()), page = JSON.parse(saved[4]!.toString())
    page.rows[1].metadataDigest = 'f'.repeat(64); root.pages.digest = recordHash('page', page)
    try {
      await writeFile(paths[4]!, JSON.stringify(page)); await writeFile(paths[0]!, JSON.stringify(root)); await writeFile(paths[1]!, JSON.stringify(appliedFor(root))); await unlink(paths[2]!); await unlink(paths[3]!)
      await fundSlots(join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex')), join(folder, 'revoke'), revokedTuple(root), 64 * 1024 * 1024, () => {})
      await expect(acquireSelectedMetadata(f.service(), await f.observation())).rejects.toThrow('Inconsistent original reference commitment')
    } finally { await Promise.all(paths.map((path, i) => writeFile(path, saved[i]!))) }
  } finally { await f.close() }
})
