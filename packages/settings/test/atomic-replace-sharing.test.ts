import { afterEach, expect, it, vi } from 'vitest'
const probe = vi.hoisted(() => ({ forced: undefined as unknown, attempts: 0, failed: undefined as undefined | (() => void) }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async rename(...args: Parameters<typeof fs.rename>) {
    probe.attempts++
    try { if (probe.forced !== undefined) throw probe.forced; await fs.rename(...args) }
    catch (error) { probe.failed?.(); throw error }
  } }
})
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { writeSettingsDocument } from '../src/storage/transaction.ts'
import { instructionDocumentHash } from '../src/storage/instruction-migration.ts'

const roots: string[] = [], readers: (() => Promise<void>)[] = []
afterEach(async () => {
  probe.forced = undefined; probe.failed = undefined; probe.attempts = 0
  await Promise.all(readers.splice(0).map(release => release()))
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-settings-sharing-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-settings-sharing-')); roots.push(root)
  const path = join(root, 'settings.json'), original = JSON.stringify({ original: true })
  await writeFile(path, original)
  return { root, path, original }
}
async function holdReader(path: string, cwd: string) {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs/promises');
    (async () => {
      const handle = await fs.open(process.argv[1], 'r');
      console.log('held');
      process.stdin.once('data', async () => {
        await handle.close();
        console.log('released');
      });
      process.stdin.resume();
    })().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `, path], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', stderr = '', held = false
  const ready = Promise.withResolvers<void>()
  child.stdout.on('data', bytes => { output += String(bytes); if (output.includes('held')) { held = true; ready.resolve() } })
  child.stderr.on('data', bytes => { stderr += String(bytes) })
  child.once('error', ready.reject)
  const exited = new Promise<void>((accept, reject) => child.once('exit', code => {
    if (!held) ready.reject(Error(`Reader exited before opening: ${stderr}`))
    code === 0 ? accept() : reject(Error(`Reader exit ${code}: ${stderr}`))
  }))
  let releasing: Promise<void> | undefined
  const release = () => releasing ??= (async () => { child.stdin.end('release\n'); await exited })()
  readers.push(release)
  await ready.promise
  return release
}

it.skipIf(process.platform !== 'win32')('atomically replaces after an actual child reader releases its sharing handle', async () => {
  const f = await fixture(), release = await holdReader(f.path, f.root), failed = Promise.withResolvers<void>()
  probe.failed = failed.resolve
  const next = JSON.stringify({ saved: true }), writing = writeSettingsDocument(f.path, next)
  void writing.catch(() => {})
  try {
    const outcome = await Promise.race([writing.then(() => 'replaced' as const), failed.promise.then(() => 'sharing-blocked' as const)])
    if (outcome === 'sharing-blocked') expect(await readFile(f.path, 'utf8')).toBe(f.original)
    await release(); await writing
    expect(await readFile(f.path, 'utf8')).toBe(next)
  } finally { await release(); await writing }
}, 15_000)

it.skipIf(process.platform !== 'win32')('stops a persistent sharing failure at its bound and leaves the original bytes intact', async () => {
  const f = await fixture(), failure = Object.assign(Error('Persistent rename sharing failure'), { code: 'EPERM' })
  probe.forced = failure
  const started = performance.now()
  await expect(writeSettingsDocument(f.path, JSON.stringify({ changed: true }))).rejects.toBe(failure)
  expect(performance.now() - started).toBeLessThan(2_000)
  expect(probe.attempts).toBeGreaterThan(1)
  expect(await readFile(f.path, 'utf8')).toBe(f.original)
  expect(await readdir(f.root)).toEqual(['settings.json'])
})

it.skipIf(process.platform !== 'win32')('rechecks migration identity after a sharing failure and preserves a foreign edit', async () => {
  const f = await fixture(), release = await holdReader(f.path, f.root), failed = Promise.withResolvers<void>()
  // Force the sharing window on Windows versions that permit replacing a
  // reader-held file. Keep it held until the foreign edit is acknowledged.
  probe.forced = Object.assign(Error('Controlled rename sharing window'), { code: 'EPERM' })
  probe.failed = failed.resolve
  const writing = writeSettingsDocument(f.path, JSON.stringify({ imported: true }), instructionDocumentHash(f.original))
  const result = writing.catch(error => error)
  try {
    await failed.promise
    const foreign = JSON.stringify({ foreign: true })
    await writeFile(f.path, foreign)
    probe.forced = undefined
    await release()
    expect(await result).toMatchObject({ code: 'conflict' })
    expect(await readFile(f.path, 'utf8')).toBe(foreign)
  } finally { await release(); await result }
}, 15_000)

it.each(['EIO', 'EACCES'])('does not repeat a nontransient native %s failure', async code => {
  const f = await fixture(), failure = Object.assign(Error('Native I/O failure'), { code })
  probe.forced = failure
  await expect(writeSettingsDocument(f.path, '{}')).rejects.toBe(failure)
  expect(probe.attempts).toBe(1)
  expect(await readFile(f.path, 'utf8')).toBe(f.original)
})
