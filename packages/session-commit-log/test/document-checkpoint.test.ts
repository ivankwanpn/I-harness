import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createCommitLog, openCommitLog, COMMIT_LOG_GENERATION } from '../src/store.ts'
import { nodeIo } from '../src/io.ts'
import { generationPath, sidecarDirectory } from '../src/paths.ts'
import { acquireCommitSnapshotLease } from '../src/lease.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-document-checkpoint-')) throw Error('Unsafe cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-document-checkpoint-'))
  roots.push(root)
  const options = { root, sessionId: '__documents__', compactDocuments: true }
  const log = await createCommitLog(options, { header: { kind: 'document-store' } })
  const side = await log.writeSidecar(Buffer.from('original'))
  await log.append({ ops: [{ kind: 'doc', key: 'x', side }] })
  await log.close()
  return { options, side, path: generationPath(root, options.sessionId, COMMIT_LOG_GENERATION) }
}

async function replaceMany(options: Awaited<ReturnType<typeof fixture>>['options']) {
  const log = await openCommitLog(options, 'write')
  try {
    for (let index = 0; index < 70; index++) {
      const side = await log.writeSidecar(Buffer.from(`replacement-${index}`))
      await log.append({ ops: [{ kind: 'doc', key: 'x', side }] })
    }
    await log.append({ ops: [{ kind: 'doc-clear', key: 'legacy-cleared' }] })
  } finally { await log.close() }
}

it('checkpoints current values and durable clear tombstones, then reclaims replaced sidecars', async () => {
  const f = await fixture()
  await replaceMany(f.options)
  const previousBytes = (await readFile(f.path)).length
  const log = await openCommitLog(f.options, 'write')
  try {
    expect(log.records()).toHaveLength(1)
    expect(log.records()[0]!.ops).toContainEqual({ kind: 'doc-clear', key: 'legacy-cleared' })
    expect(Buffer.from(await log.readSidecar(log.view().documents.get('x')!.digest)).toString()).toBe('replacement-69')
    expect((await readFile(f.path)).length).toBeLessThan(previousBytes / 10)
    expect(await readdir(sidecarDirectory(f.options.root, f.options.sessionId))).toHaveLength(1)
    await expect(log.readSidecar(f.side.digest)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await log.close() }
}, 20_000)

it.each(['close', 'crash'] as const)('retains an original cross-process reader until %s releases its native lease', async ending => {
  const f = await fixture()
  let child: ChildProcess | undefined
  try {
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/snapshot-reader.mjs', import.meta.url)), f.options.root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    const ready = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(([code]) => ({ kind: 'early-exit', code }))])
    expect(ready).toEqual({ kind: 'ready' })
    await replaceMany(f.options)
    const before = await openCommitLog(f.options, 'write')
    expect(before.records().length).toBeGreaterThan(70)
    await before.close()
    const read = once(child, 'message')
    child.send!('read')
    expect((await read)[0]).toEqual({ kind: 'read', text: 'original' })
    const exited = once(child, 'exit')
    if (ending === 'crash') child.kill('SIGKILL')
    else child.send!('close')
    await exited
    child = undefined
    const after = await openCommitLog(f.options, 'write')
    try { expect(after.records()).toHaveLength(1); await expect(after.readSidecar(f.side.digest)).rejects.toMatchObject({ code: 'ENOENT' }) }
    finally { await after.close() }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
  }
}, 20_000)

it('keeps the original generation when checkpoint publication fails and retries from the same state', async () => {
  const f = await fixture()
  await replaceMany(f.options)
  const original = await readFile(f.path)
  const io = { ...nodeIo, async rename() { throw Object.assign(Error('injected checkpoint rename'), { code: 'EIO' }) } }
  await expect(openCommitLog({ ...f.options, io }, 'write')).rejects.toThrow('injected checkpoint rename')
  expect(await readFile(f.path)).toEqual(original)
  const log = await openCommitLog(f.options, 'write')
  try { expect(log.records()).toHaveLength(1) } finally { await log.close() }
}, 20_000)

it('releases the reader lease when loading its generation fails', async () => {
  const f = await fixture()
  const io = { ...nodeIo, async readFile() { throw Error('injected generation read') } }
  await expect(openCommitLog({ ...f.options, io }, 'read')).rejects.toThrow('injected generation read')
  const maintenance = await acquireCommitSnapshotLease(f.options.sessionId, { lockRoot: f.options.root, deadlineMs: 0 }, 'exclusive')
  await maintenance.release()
})

it('keeps a missing read passive before acquiring its retention lease', async () => {
  const f = await fixture()
  const missing = join(f.options.root, 'missing-store')
  await expect(openCommitLog({ root: missing, sessionId: 'absent' }, 'read')).rejects.toMatchObject({ code: 'COMMIT_LOG_NOT_FOUND' })
  await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains the full event and operation history of ordinary session logs', async () => {
  const f = await fixture()
  const log = await openCommitLog(f.options, 'write')
  try {
    for (let index = 0; index < 70; index++) await log.append({ entries: [{ type: 'test', index } as never] })
  } finally { await log.close() }
  const reopened = await openCommitLog(f.options, 'write')
  try { expect(reopened.records()).toHaveLength(72); expect(reopened.entryCount()).toBe(70) }
  finally { await reopened.close() }
}, 20_000)
