import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { createCommitLog, openCommitLog, CommitLogConflictError, COMMIT_LOG_GENERATION } from '../src/store.ts'
import { nodeIo, type CommitLogIo } from '../src/io.ts'
import { generationPath, sessionDirectory } from '../src/paths.ts'

const roots: string[] = [], readers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(readers.splice(0).map(release => release()))
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-commit-recreate-sharing-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'ih-commit-recreate-sharing-'))
  roots.push(path)
  return path
}
async function tombstone() {
  const base = await root()
  const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: { incarnation: 'deleted' } })
  try { await log.append({ ops: [{ kind: 'delete' }] }) } finally { await log.close() }
  const path = generationPath(base, 's1', COMMIT_LOG_GENERATION)
  return { base, path, before: await readFile(path) }
}
async function holdReader(path: string) {
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs/promises');
    (async () => {
      const handle = await fs.open(process.argv[1], 'r');
      console.log('held');
      process.stdin.once('data', async () => { await handle.close(); process.stdin.destroy(); });
      process.stdin.resume();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const ready = Promise.withResolvers<void>()
  let output = '', errors = '', held = false
  child.stdout.on('data', bytes => { output += String(bytes); if (output.includes('held')) { held = true; ready.resolve() } })
  child.stderr.on('data', bytes => { errors += String(bytes) })
  child.once('error', ready.reject)
  const exited = new Promise<void>((accept, reject) => child.once('exit', code => {
    if (!held) ready.reject(Error('Reader did not open: ' + errors))
    code === 0 ? accept() : reject(Error('Reader exit ' + code + ': ' + errors))
  }))
  let releasing: Promise<void> | undefined
  const release = () => releasing ??= (async () => { child.stdin.end('release\n'); await exited })()
  readers.push(release)
  await ready.promise
  return release
}

it.skipIf(process.platform !== 'win32')('publishes the same completed recreation stage after an actual reader releases', async () => {
  const f = await tombstone(), release = await holdReader(f.path)
  const blocked = Promise.withResolvers<void>(), stages = new Set<string>()
  let released = false, attempts = 0
  const io: CommitLogIo = { ...nodeIo, async rename(stage, target) {
    stages.add(stage); attempts++
    // Keep the sharing window deterministic even on a Windows version that
    // permits replacement of this particular reader handle.
    if (!released) { blocked.resolve(); throw Object.assign(Error('Reader-held sharing window'), { code: 'EPERM' }) }
    await nodeIo.rename(stage, target)
  } }
  const writing = createCommitLog({ root: f.base, sessionId: 's1', recreateDeleted: true, io }, { header: { incarnation: 'replacement' } })
  void writing.catch(() => {})
  try {
    await blocked.promise
    expect(await readFile(f.path)).toEqual(f.before)
    await release(); released = true
    const recreated = await writing
    try { expect(recreated.header().incarnation).toBe('replacement') } finally { await recreated.close() }
    expect(attempts).toBeGreaterThan(1)
    expect(stages.size).toBe(1)
  } finally { await release(); released = true; await writing.then(log => log.close(), () => {}) }
}, 15_000)

it.skipIf(process.platform !== 'win32')('bounds persistent sharing failure and preserves the complete deleted generation', async () => {
  const f = await tombstone(), failure = Object.assign(Error('Persistent sharing failure'), { code: 'EPERM' })
  let attempts = 0
  const io: CommitLogIo = { ...nodeIo, async rename() { attempts++; throw failure } }
  const started = performance.now()
  await expect(createCommitLog({ root: f.base, sessionId: 's1', recreateDeleted: true, io }, { header: { incarnation: 'replacement' } })).rejects.toBe(failure)
  expect(performance.now() - started).toBeLessThan(2_000)
  expect(attempts).toBeGreaterThan(1)
  expect(await readFile(f.path)).toEqual(f.before)
  expect(await readdir(sessionDirectory(f.base, 's1'))).toEqual(['session.v15.jsonl'])
  const saved = await openCommitLog({ root: f.base, sessionId: 's1' }, 'read')
  try { expect(saved.view().deleted).toBe(true) } finally { await saved.close() }
})

it.skipIf(process.platform !== 'win32')('refuses a changed live generation before retrying replacement', async () => {
  const f = await tombstone(), foreignRoot = await root()
  const foreign = await createCommitLog({ root: foreignRoot, sessionId: 's1' }, { header: { incarnation: 'foreign-live' } })
  await foreign.close()
  const foreignBytes = await readFile(generationPath(foreignRoot, 's1', COMMIT_LOG_GENERATION))
  let attempts = 0
  const io: CommitLogIo = { ...nodeIo, async rename() {
    attempts++
    await writeFile(f.path, foreignBytes)
    throw Object.assign(Error('Controlled sharing window'), { code: 'EBUSY' })
  } }
  await expect(createCommitLog({ root: f.base, sessionId: 's1', recreateDeleted: true, io }, { header: { incarnation: 'replacement' } })).rejects.toBeInstanceOf(CommitLogConflictError)
  expect(attempts).toBe(1)
  expect(await readFile(f.path)).toEqual(foreignBytes)
})

it.each(['EACCES', 'EIO'])('does not retry non-sharing recreation failure %s', async code => {
  const f = await tombstone(), failure = Object.assign(Error('Non-sharing failure'), { code })
  let attempts = 0
  const io: CommitLogIo = { ...nodeIo, async rename() { attempts++; throw failure } }
  await expect(createCommitLog({ root: f.base, sessionId: 's1', recreateDeleted: true, io }, { header: {} })).rejects.toBe(failure)
  expect(attempts).toBe(1)
  expect(await readFile(f.path)).toEqual(f.before)
})

it('keeps first-create publication on its no-overwrite link path', async () => {
  const base = await root()
  const original = await createCommitLog({ root: base, sessionId: 's1' }, { header: { incarnation: 'original' } })
  await original.close()
  const path = generationPath(base, 's1', COMMIT_LOG_GENERATION), before = await readFile(path)
  let renames = 0
  const io: CommitLogIo = { ...nodeIo, async rename() { renames++; throw Error('First create must not replace') } }
  await expect(createCommitLog({ root: base, sessionId: 's1', io }, { header: {} })).rejects.toBeInstanceOf(CommitLogConflictError)
  expect(renames).toBe(0)
  expect(await readFile(path)).toEqual(before)
})
