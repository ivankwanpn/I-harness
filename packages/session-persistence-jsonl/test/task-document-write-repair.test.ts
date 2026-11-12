import { expect, it, vi } from 'vitest'
const faults = vi.hoisted(() => ({ path: '', active: false, numericStats: 0, readFiles: 0, readBytes: 0, grow: false,
  failClose: false, closes: 0, closeGate: undefined as Promise<void> | undefined, closeEntered: undefined as (() => void) | undefined,
  failUnlink: false, unlinks: 0, unlinkGate: undefined as Promise<void> | undefined, unlinkEntered: undefined as (() => void) | undefined,
  published: false, revokeAfterPublish: false, revoke: undefined as (() => void) | undefined, finalOpens: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real,
    async lstat(...args: Parameters<typeof real.lstat>) {
      if (faults.active && !args[1]?.bigint) faults.numericStats++
      const stat = await real.lstat(...args)
      return stat
    },
    async open(...args: Parameters<typeof real.open>) {
      const handle = await real.open(...args), stat = handle.stat.bind(handle), read = handle.read.bind(handle), readFile = handle.readFile.bind(handle), close = handle.close.bind(handle)
      const target = String(args[0]) === faults.path
      if (target && args[1] === 'r+') faults.finalOpens++
      handle.stat = (async (...input: Parameters<typeof stat>) => {
        if (faults.active && !input[0]?.bigint) faults.numericStats++
        const value = await stat(...input)
        if (target && args[1] === 'r' && faults.grow) { faults.grow = false; await real.appendFile(faults.path, Buffer.alloc(1024, 120)) }
        return value
      }) as typeof handle.stat
      handle.read = (async (...input: [Buffer, number, number, number]) => { const value = await read(...input); if (faults.active && target) faults.readBytes += value.bytesRead; return value }) as typeof handle.read
      handle.readFile = (async (...input: Parameters<typeof readFile>) => { if (faults.active && target) faults.readFiles++; return readFile(...input) }) as typeof handle.readFile
      if (target && args[1] === 'r+') handle.close = async () => {
        if (faults.failClose) throw null
        faults.closes++; faults.closeEntered?.(); await faults.closeGate; await close()
      }
      return handle
    },
    async rename(...args: Parameters<typeof real.rename>) {
      await real.rename(...args)
      if (String(args[1]) === faults.path) {
        faults.published = true
        if (faults.revokeAfterPublish) faults.revoke?.()
      }
    },
    async unlink(...args: Parameters<typeof real.unlink>) {
      if (String(args[0]).startsWith(faults.path + '.') && String(args[0]).endsWith('.tmp')) {
        if (faults.failUnlink) throw false
        faults.unlinks++; faults.unlinkEntered?.(); await faults.unlinkGate
      }
      return real.unlink(...args)
    },
  }
})
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { issueHeldTaskDocumentScope } from '../../session-persistence/src/coordinator/task-document-scope.ts'
import { createTaskDocumentObservation } from '../src/backend/task-document-observation.ts'

async function fixture(run: (session: ReturnType<typeof createTaskDocumentObservation>, path: string) => Promise<void>) {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'write-repair-')), store = join(root, 'store'); await mkdir(store)
  const owner = createOwnership({ lockRoot: root }, { lock: { enabled: true } }), pin = await owner.pinOwnership('p'), lease = await owner.acquireLease('doc:task-p')
  let live = true
  const scope = issueHeldTaskDocumentScope(owner, 'p', pin, { assertActive() { if (!live || !lease.held) throw Error('revoked') } })
  faults.path = join(store, 'task-p.doc.jsonl'); faults.revoke = () => { live = false }
  const session = createTaskDocumentObservation(store, faults.path, scope)
  try { await run(session, faults.path) }
  finally {
    faults.active = false; faults.grow = false; faults.failClose = false; faults.failUnlink = false; faults.closeGate = undefined; faults.unlinkGate = undefined
    faults.closeEntered = undefined; faults.unlinkEntered = undefined; faults.published = false; faults.revokeAfterPublish = false; faults.revoke = undefined
    await session.settleResources(); await lease.release(); await pin.release(); await rm(root, { recursive: true, force: true })
    faults.path = ''; faults.closes = 0; faults.unlinks = 0; faults.numericStats = 0; faults.readFiles = 0; faults.readBytes = 0; faults.finalOpens = 0
  }
}
async function replacement(session: ReturnType<typeof createTaskDocumentObservation>, path: string) {
  await writeFile(path, '{"x":1}'); const observed = await session.observe(); if (observed.kind !== 'present') throw Error('missing')
  return session.stageWrite(observed.witness, Buffer.from('{"x":2}\n'))
}
it('joins committed cleanup retries and original session close over the same final descriptor', async () => fixture(async (session, path) => {
  const write = await replacement(session, path); faults.failClose = true
  const result = await write.issue(); expect(result.kind).toBe('committed'); faults.failClose = false
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); faults.closeGate = gate.promise; faults.closeEntered = entered.resolve; faults.closes = 0
  const a = write.retry(), b = write.retry(), c = session.settleResources()
  try { await entered.promise; expect(faults.closes).toBe(1) } finally { gate.resolve() }
  const [first, second] = await Promise.all([a, b, c]); expect(first).toMatchObject({ kind: 'committed', cleanupPending: false }); expect(second).toEqual(first)
  if (result.kind === 'committed' && first.kind === 'committed') expect(first.ack).toBe(result.ack)
}))
it('joins original temp unlink cleanup across committed retries and session settlement', async () => fixture(async (session) => {
  await session.observe(); const write = session.stageInitialize(Buffer.from('{"x":2}\n')); faults.failUnlink = true
  expect(await write.issue()).toMatchObject({ kind: 'committed', cleanupPending: true }); faults.failUnlink = false
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); faults.unlinkGate = gate.promise; faults.unlinkEntered = entered.resolve; faults.unlinks = 0
  const jobs = [write.retry(), write.retry(), session.settleResources()]
  try { await entered.promise; expect(faults.unlinks).toBe(1) } finally { gate.resolve() }
  await Promise.all(jobs); expect(write.outcome()).toMatchObject({ kind: 'committed', cleanupPending: false })
}))
it('bounds preimage reads when the original descriptor grows after metadata', async () => fixture(async (session, path) => {
  const write = await replacement(session, path); faults.active = true; faults.grow = true; faults.readBytes = 0; faults.readFiles = 0
  expect((await write.issue()).kind).toBe('conflict'); expect(faults.readFiles).toBe(0); expect(faults.readBytes).toBeLessThanOrEqual(8)
  faults.active = false; expect((await readFile(path)).length).toBe(1031)
}))
it('does not acquire a final writable descriptor after revocation during original publication', async () => fixture(async (session, path) => {
  const write = await replacement(session, path); faults.finalOpens = 0; faults.revokeAfterPublish = true
  expect((await write.issue()).kind).toBe('unknown'); expect(faults.published).toBe(true); expect(faults.finalOpens).toBe(0)
  expect(await readFile(path, 'utf8')).toBe('{"x":2}\n')
}))
it('uses exact native bigint identity throughout raw observation and retained publication', async () => fixture(async (session, path) => {
  faults.active = true; faults.revoke = undefined; faults.numericStats = 0
  await writeFile(path, '{"formatVersion":1,"tasks":[],"notifications":[]}')
  const observed = await session.observe(); if (observed.kind !== 'present') throw Error('missing')
  expect((await session.confirm(observed.witness)).kind).toBe('confirmed')
  const write = session.stageWrite(observed.witness, Buffer.from('{"formatVersion":2,"tasks":[],"notifications":[]}\n'))
  expect((await write.issue()).kind).toBe('committed'); expect(faults.numericStats).toBe(0)
}))
