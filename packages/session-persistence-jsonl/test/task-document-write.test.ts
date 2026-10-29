import { expect, it, vi } from 'vitest'
const controls = vi.hoisted(() => ({ throwAfterRename: false, throwAfterLink: false, failClose: false, partial: false, writes: 0, tempOpens: 0, finalOpens: 0, finalPath: '', beforeLink: undefined as undefined | ((path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async original => { const fs = await original<typeof import('node:fs/promises')>(); return { ...fs, open: async (...args: Parameters<typeof fs.open>) => { const handle = await fs.open(...args), close = handle.close.bind(handle), write = handle.write.bind(handle); if (String(args[0]) === controls.finalPath && args[1] === 'r+') { controls.finalOpens++; handle.close = async () => { if (controls.failClose) throw null; await close() } }; if (String(args[0]).endsWith('.tmp') && args[1] === 'wx') { controls.tempOpens++; handle.write = (async (buffer: Uint8Array, offset: number, length: number, position: number) => { if (controls.partial && controls.writes++ > 0) throw new Error('partial write'); return write(buffer, offset, controls.partial ? Math.min(3, length) : length, position) }) as typeof handle.write }; return handle }, rename: async (...args: Parameters<typeof fs.rename>) => { await fs.rename(...args); if (controls.throwAfterRename) throw new Error('after rename') }, link: async (...args: Parameters<typeof fs.link>) => { await controls.beforeLink?.(String(args[1])); await fs.link(...args); if (controls.throwAfterLink) throw new Error('after link') } } })
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { issueHeldTaskDocumentScope } from '../../session-persistence/src/coordinator/task-document-scope.ts'
import { createTaskDocumentObservation } from '../src/backend/task-document-observation.ts'

async function fixture(run: (scope: ReturnType<typeof issueHeldTaskDocumentScope>, root: string, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ih-write-backend-')), store = join(root, 'store'); await mkdir(store)
  const owner = createOwnership({ lockRoot: root }, { lock: { enabled: true } }), pin = await owner.pinOwnership('p'), lease = await owner.acquireLease('doc:task-p')
  const scope = issueHeldTaskDocumentScope(owner, 'p', pin, { assertActive() { if (!lease.held) throw new Error('revoked') } })
  try { await run(scope, store, join(store, 'task-p.doc.jsonl')) } finally { controls.throwAfterRename = false; controls.throwAfterLink = false; controls.failClose = false; controls.partial = false; controls.writes = 0; controls.tempOpens = 0; controls.finalOpens = 0; controls.finalPath = ''; controls.beforeLink = undefined; await lease.release(); await pin.release(); await rm(root, { recursive: true, force: true }) }
}
it('refuses a same-value different-byte preimage without overwriting it', async () => fixture(async (scope, root, path) => {
  await writeFile(path, '{"x":1}'); const session = createTaskDocumentObservation(root, path, scope), initial = await session.observe(); if (initial.kind !== 'present') throw new Error('missing')
  const operation = session.stageWrite(initial.witness, Buffer.from('{"x":2}\n')); await writeFile(path, '{ "x":1 }')
  expect((await operation.issue()).kind).toBe('conflict'); expect(await readFile(path, 'utf8')).toBe('{ "x":1 }'); await session.settleResources()
}))
it('initializes through a non-overwriting link and rejects an equal foreign race', async () => fixture(async (scope, root, path) => {
  const session = createTaskDocumentObservation(root, path, scope); expect(await session.observe()).toEqual({ kind: 'absent' })
  const bytes = Buffer.from('{"x":1}\n'), operation = session.stageInitialize(bytes)
  controls.beforeLink = async target => { await writeFile(target, bytes) }
  expect((await operation.issue()).kind).toBe('conflict'); expect(await readFile(path)).toEqual(bytes); await session.settleResources()
}))
it('initializes the original candidate through a real same-directory link', async () => fixture(async (scope, root, path) => {
  const session = createTaskDocumentObservation(root, path, scope); expect(await session.observe()).toEqual({ kind: 'absent' })
  const bytes = Buffer.from('{"x":1}\n'), operation = session.stageInitialize(bytes)
  expect((await operation.issue()).kind).toBe('committed'); expect(await readFile(path)).toEqual(bytes); await session.settleResources()
}))
it('reconciles an original hard-link publication after the link response is lost', async () => fixture(async (scope, root, path) => {
  const session = createTaskDocumentObservation(root, path, scope); await session.observe()
  const bytes = Buffer.from('{"x":1}\n'), operation = session.stageInitialize(bytes); controls.throwAfterLink = true
  expect((await operation.issue()).kind).toBe('unknown'); controls.throwAfterLink = false
  expect((await operation.reconcile()).kind).toBe('committed'); expect(await readFile(path)).toEqual(bytes); await session.settleResources()
}))
it('does not fall back to rename when the original link is unsupported', async () => fixture(async (scope, root, path) => {
  const session = createTaskDocumentObservation(root, path, scope); await session.observe()
  const operation = session.stageInitialize(Buffer.from('{"x":1}\n'))
  controls.beforeLink = async () => { throw Object.assign(new Error('unsupported link'), { code: 'ENOTSUP' }) }
  expect((await operation.issue()).kind).toBe('unknown'); await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' }); await session.settleResources()
}))
it('reconciles only the original candidate after a publication response loss', async () => fixture(async (scope, root, path) => {
  await writeFile(path, '{"x":1}'); const session = createTaskDocumentObservation(root, path, scope), initial = await session.observe(); if (initial.kind !== 'present') throw new Error('missing')
  const operation = session.stageWrite(initial.witness, Buffer.from('{"x":2}\n')); controls.throwAfterRename = true
  expect((await operation.issue()).kind).toBe('unknown'); controls.throwAfterRename = false
  expect((await operation.reconcile()).kind).toBe('committed'); expect(await readFile(path, 'utf8')).toBe('{"x":2}\n'); await session.settleResources()
}))
it('retains a committed ack and original final handle until explicit cleanup retry', async () => fixture(async (scope, root, path) => {
  await writeFile(path, '{"x":1}'); const session = createTaskDocumentObservation(root, path, scope), initial = await session.observe(); if (initial.kind !== 'present') throw new Error('missing')
  const operation = session.stageWrite(initial.witness, Buffer.from('{"x":2}\n')); controls.finalPath = path; controls.failClose = true
  const outcome = await operation.issue(); expect(outcome).toMatchObject({ kind: 'committed', cleanupPending: true }); expect(operation.outcome()).toBe(outcome)
  expect(controls.finalOpens).toBe(1); await expect(session.settleResources()).rejects.toBeNull(); controls.failClose = false; await session.settleResources(); expect(controls.finalOpens).toBe(1)
  expect((await operation.retry()).kind).toBe('committed')
}))
it('continues the original partial temp instead of creating another candidate', async () => fixture(async (scope, root, path) => {
  await writeFile(path, '{"x":1}'); const session = createTaskDocumentObservation(root, path, scope), initial = await session.observe(); if (initial.kind !== 'present') throw new Error('missing')
  const operation = session.stageWrite(initial.witness, Buffer.from('{"x":2}\n')); controls.partial = true
  expect((await operation.issue()).kind).toBe('unknown'); expect(controls.tempOpens).toBe(1); controls.partial = false
  expect((await operation.retry()).kind).toBe('committed'); expect(controls.tempOpens).toBe(1); expect(await readFile(path, 'utf8')).toBe('{"x":2}\n'); await session.settleResources()
}))
