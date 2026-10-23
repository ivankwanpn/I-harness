import { expect, it, vi, afterEach } from 'vitest'
const controls = vi.hoisted(() => ({ path: '', maxWrite: Infinity, writes: 0, syncs: 0, publications: 0, cleanups: 0, afterWrite: undefined as undefined | (() => void), beforeLink: undefined as undefined | (() => Promise<void>), afterSync: undefined as undefined | (() => void), failSync: false, failLink: false, loseLink: false, failCleanup: false, failClose: false }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if (!String(args[0]).startsWith(controls.path) || !controls.path) return handle
      const write = handle.write.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle)
      handle.write = (async (bytes: Buffer, offset: number, length: number, position: number) => {
        const result = await write(bytes, offset, Math.min(length, controls.maxWrite), position)
        controls.writes++; controls.afterWrite?.(); return result
      }) as typeof handle.write
      let synced = false
      handle.sync = async () => { controls.syncs++; if (controls.failSync) throw new Error('sync cut'); await sync(); synced = true; controls.afterSync?.() }
      handle.close = async () => { await close(); if (synced && controls.failClose) throw new Error('post-sync close response lost') }
      return handle
    },
    link: async (...args: Parameters<typeof fs.link>) => {
      if (String(args[1]) !== controls.path) return fs.link(...args)
      controls.publications++; await controls.beforeLink?.(); if (controls.failLink) throw new Error('link unavailable')
      await fs.link(...args); if (controls.loseLink) throw new Error('link response lost')
    },
    unlink: async (...args: Parameters<typeof fs.unlink>) => { if (String(args[0]).startsWith(controls.path) && controls.path) { controls.cleanups++; if (controls.failCleanup) throw new Error('cleanup cut') }; await fs.unlink(...args) },
  }
})
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { atomicJson, continueAtomicJson, confirmAtomicJson } from '../src/artifact/io.ts'
import { structureEvidence } from './structure-evidence.ts'
const evidence = resolve(structureEvidence(resolve(import.meta.dirname, '../../../.tmp/context-parallel-artifact-20261023')), 'metadata')
await mkdir(evidence, { recursive: true })
const value = { version: 1, kind: 'literal', value: '漢字🙂' }
const bytes = Buffer.from(JSON.stringify(value))
const pending = (path: string) => path + '.' + createHash('sha256').update(bytes).digest('hex') + '.pending'
async function fixture() { const root = await mkdtemp(resolve(evidence, 'bytes-')); return { root, path: resolve(root, 'record.json') } }
afterEach(() => Object.assign(controls, { path: '', maxWrite: Infinity, writes: 0, syncs: 0, publications: 0, cleanups: 0, afterWrite: undefined, beforeLink: undefined, afterSync: undefined, failSync: false, failLink: false, loseLink: false, failCleanup: false, failClose: false }))

it('passively distinguishes absent, partial, foreign and exact final metadata without filling retained work', async () => {
  const f = await fixture(); controls.path = f.path
  expect((await confirmAtomicJson(f.root, f.path, value)).kind).toBe('absent')
  await writeFile(pending(f.path), bytes.subarray(0, 7))
  expect((await confirmAtomicJson(f.root, f.path, value)).kind).toBe('unknown')
  expect(await readFile(pending(f.path))).toEqual(bytes.subarray(0, 7))
  expect(controls.writes + controls.publications + controls.cleanups).toBe(0)
  expect((await continueAtomicJson(f.root, f.path, value, () => false)).kind).toBe('unknown')
  expect((await continueAtomicJson(f.root, f.path, value, () => true)).kind).toBe('confirmed')
  expect(await readFile(f.path)).toEqual(bytes)
  expect((await confirmAtomicJson(f.root, f.path, value)).kind).toBe('confirmed')
  const foreign = f.path + '.' + 'f'.repeat(64) + '.pending'
  await writeFile(foreign, 'foreign')
  expect((await confirmAtomicJson(f.root, f.path, value)).kind).toBe('conflict')
  expect((await continueAtomicJson(f.root, f.path, value, () => true)).kind).toBe('conflict')
  expect(await readFile(foreign, 'utf8')).toBe('foreign'); expect(await readFile(f.path)).toEqual(bytes)
})

it('checks currentness between real short writes and retains exact pending bytes after Stop', async () => {
  const f = await fixture(); controls.path = f.path; controls.maxWrite = 5
  let current = true; controls.afterWrite = () => { current = false }
  expect((await continueAtomicJson(f.root, f.path, value, () => current)).kind).toBe('unknown')
  expect(await readFile(pending(f.path))).toEqual(bytes.subarray(0, 5)); expect(controls.writes).toBe(1); expect(controls.publications).toBe(0)
  controls.afterWrite = undefined
  expect((await continueAtomicJson(f.root, f.path, value, () => true)).kind).toBe('confirmed')
  expect(await readFile(f.path)).toEqual(bytes)
  const stopped = await fixture(); controls.path = stopped.path
  current = true; controls.afterSync = () => { current = false }
  const publications = controls.publications
  expect((await continueAtomicJson(stopped.root, stopped.path, value, () => current)).kind).toBe('unknown')
  expect(controls.publications).toBe(publications)
  expect(await readFile(pending(stopped.path))).toEqual(bytes)
  await expect(readFile(stopped.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['sync', 'link', 'response'] as const)('retains real %s uncertainty and permits passive confirmation only after final publication', async cut => {
  const f = await fixture(); controls.path = f.path
  controls.failSync = cut === 'sync'; controls.failLink = cut === 'link'; controls.loseLink = cut === 'response'
  expect((await continueAtomicJson(f.root, f.path, value, () => true)).kind).toBe('unknown')
  Object.assign(controls, { failSync: false, failLink: false, loseLink: false })
  const before = await readdir(f.root), writes = controls.writes, publications = controls.publications, cleanups = controls.cleanups
  expect((await confirmAtomicJson(f.root, f.path, value)).kind).toBe(cut === 'response' ? 'confirmed' : 'unknown')
  expect(await readdir(f.root)).toEqual(before); expect(controls.writes).toBe(writes); expect(controls.publications).toBe(publications); expect(controls.cleanups).toBe(cleanups)
  expect((await continueAtomicJson(f.root, f.path, value, () => true)).kind).toBe('confirmed')
  expect(await readFile(f.path)).toEqual(bytes)
})

it('does not clobber a foreign final inserted at atomic publication and retains the original transaction', async () => {
  const f = await fixture(); controls.path = f.path
  controls.beforeLink = () => writeFile(f.path, 'foreign final inserted before publication')
  expect((await continueAtomicJson(f.root, f.path, value, () => true)).kind).toBe('conflict')
  expect(await readFile(f.path, 'utf8')).toBe('foreign final inserted before publication')
  expect(await readFile(pending(f.path))).toEqual(bytes)
})

it('preserves confirmed final bytes and cleanup diagnostics after sync, cleanup failure or currentness loss', async () => {
  for (const cut of ['cleanup', 'current', 'close'] as const) {
    const f = await fixture(); controls.path = f.path
    let current = true
    if (cut === 'cleanup') controls.failCleanup = true
    if (cut === 'current') controls.beforeLink = async () => { current = false }
    const result = await continueAtomicJson(f.root, f.path, value, () => current)
    expect(result.kind).toBe('confirmed'); expect(await readFile(f.path)).toEqual(bytes)
    if (cut !== 'close') { expect(result.diagnostics?.length).toBeGreaterThan(0); expect(await readFile(pending(f.path))).toEqual(bytes) }
    else {
      controls.failClose = true
      const passive = await confirmAtomicJson(f.root, f.path, value)
      expect(passive.kind).toBe('confirmed'); expect(passive.diagnostics?.length).toBeGreaterThan(0)
    }
    Object.assign(controls, { beforeLink: undefined, failCleanup: false, failClose: false })
  }
})

it('never overwrites conflicting final/pending bytes and preserves ordinary mutable atomicJson callers', async () => {
  for (const location of ['final', 'pending'] as const) {
    const f = await fixture(), path = location === 'final' ? f.path : pending(f.path)
    await writeFile(path, 'conflicting')
    expect((await continueAtomicJson(f.root, f.path, value, () => true)).kind).toBe('conflict')
    expect(await readFile(path, 'utf8')).toBe('conflicting')
  }
  const f = await fixture()
  expect((await continueAtomicJson(f.root, f.path, value, () => false)).kind).toBe('not-issued')
  expect(await readdir(f.root)).toEqual([])
  await atomicJson(f.path, { old: true }); await atomicJson(f.path, value); expect(await readFile(f.path)).toEqual(bytes)
  const oversized = await fixture()
  expect((await continueAtomicJson(oversized.root, oversized.path, { huge: 'x'.repeat(65536) }, () => true)).kind).toBe('conflict')
  expect(await readdir(oversized.root)).toEqual([])
  const maximum = await fixture()
  expect((await continueAtomicJson(maximum.root, maximum.path, { data: 'x'.repeat(65525) }, () => true)).kind).toBe('confirmed')
  expect((await readFile(maximum.path)).length).toBe(65536)
})

it('refuses JSON lossy properties before any getter or toJSON can run and captures bytes before the first await', async () => {
  let invoked = 0
  const hidden = Object.defineProperty({ version: 1 }, 'foreign', { value: true, enumerable: false })
  const getter = Object.defineProperty({ version: 1 }, 'value', { get() { invoked++; return 1 }, enumerable: true })
  const array = [1] as number[] & { extra?: string }; array.extra = 'dropped'
  for (const invalid of [hidden, getter, { toJSON() { invoked++; return {} } }, { missing: undefined }, [undefined], new Array(2), array, { [Symbol('hidden')]: true }, new Proxy({}, {})]) {
    const f = await fixture()
    expect((await continueAtomicJson(f.root, f.path, invalid, () => true)).kind).toBe('conflict')
    expect(await readdir(f.root)).toEqual([])
  }
  expect(invoked).toBe(0)
  const f = await fixture(), captured = { version: 1, value: 'original' }
  const work = continueAtomicJson(f.root, f.path, captured, () => true)
  captured.value = 'caller mutation'
  expect((await work).kind).toBe('confirmed')
  expect(await readFile(f.path, 'utf8')).toBe('{"version":1,"value":"original"}')
})
