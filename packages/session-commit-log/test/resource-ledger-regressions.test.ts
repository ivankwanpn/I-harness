import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionLock } from '@i-harness/fs-lock'

const probe = vi.hoisted(() => ({ enabled: false, writerPath: '', snapshotPath: '', fail: '' as string, error: Error('original release refused'), events: [] as string[], actuals: [] as SessionLock[] }))
vi.mock('@i-harness/fs-lock', async original => {
  const native = await original<typeof import('@i-harness/fs-lock')>()
  return { ...native, async acquireSessionLock(...args: Parameters<typeof native.acquireSessionLock>) {
    const actual = await native.acquireSessionLock(...args)
    if (!probe.enabled) return actual
    probe.actuals.push(actual)
    const role = args[0].lockPath === probe.writerPath ? 'writer' : args[0].mode === 'shared' ? 'reader' : 'maintenance'
    return { get held() { return actual.held }, async release() {
      probe.events.push(`${role}:attempt`)
      if (probe.fail === role) throw probe.error
      await actual.release()
      probe.events.push(`${role}:closed`)
    } }
  } }
})
import { lockPathFor, SessionLockConflictError } from '@i-harness/fs-lock'
import { createCommitLog, openCommitLog, type CommitLog } from '../src/store.ts'
import { CommitLogCleanupError, CommitLogResources } from '../src/resources.ts'
import { acquireCommitLease, acquireCommitSnapshotLease, type CommitLease } from '../src/lease.ts'
import { nodeIo } from '../src/io.ts'

const roots: string[] = []
afterEach(async () => {
  probe.enabled = false; probe.fail = ''
  for (const actual of probe.actuals.splice(0)) await actual.release()
  probe.events = []
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('ih-resource-ledger-')) throw Error('Unsafe fixture cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-resource-ledger-')); roots.push(root)
  const options = { root, sessionId: 'source' }, log = await createCommitLog(options, { header: { sessionId: 'source' } })
  await log.close()
  probe.writerPath = lockPathFor(root, 'commit-log:source')
  probe.snapshotPath = lockPathFor(root, 'commit-log-snapshots:source')
  probe.events = []; probe.enabled = true
  return { root, options, path: join(root, 'source', 'session.v15.jsonl') }
}
function contains(error: unknown, original: unknown): boolean {
  return error === original || error instanceof AggregateError && error.errors.some(value => contains(value, original))
}
async function failure(work: Promise<CommitLog>): Promise<CommitLogCleanupError> {
  try { const unexpected = await work; await unexpected.close(); throw Error('Expected an original cleanup failure') }
  catch (error) { expect(error).toBeInstanceOf(CommitLogCleanupError); return error as CommitLogCleanupError }
}
async function blocked(acquire: () => Promise<CommitLease>) {
  probe.enabled = false
  let acquired: CommitLease | undefined
  try {
    try { acquired = await acquire() } catch (error) { expect(error).toBeInstanceOf(SessionLockConflictError); return }
    throw Error('The original admitting lease was released before its resource')
  } finally { await acquired?.release(); probe.enabled = true }
}

it('retains the actual shared lease after failed-open cleanup and retries that original release', async () => {
  const f = await fixture(), read = Error('original generation read failed')
  probe.fail = 'reader'
  const error = await failure(openCommitLog({ ...f.options, io: { ...nodeIo, async readFile() { throw read } } }, 'read'))
  try {
    expect(contains(error, read)).toBe(true); expect(contains(error, probe.error)).toBe(true)
    await blocked(() => acquireCommitSnapshotLease('source', { lockRoot: f.root, deadlineMs: 0 }, 'exclusive'))
    probe.fail = ''; await error.cleanup.close()
    expect(probe.events).toEqual(['reader:attempt', 'reader:attempt', 'reader:closed'])
    probe.enabled = false
    const maintenance = await acquireCommitSnapshotLease('source', { lockRoot: f.root, deadlineMs: 0 }, 'exclusive')
    await maintenance.release()
  } finally { probe.fail = ''; await error.cleanup.close() }
}, 15000)

it('keeps the writer lease behind a failed maintenance close until the same maintenance resource closes', async () => {
  const f = await fixture(); probe.fail = 'maintenance'
  const error = await failure(openCommitLog(f.options, 'write'))
  try {
    expect(contains(error, probe.error)).toBe(true)
    expect(probe.events.every(event => event.startsWith('maintenance:'))).toBe(true)
    await blocked(() => acquireCommitLease('source', { lockRoot: f.root, deadlineMs: 0 }))
    await blocked(() => acquireCommitSnapshotLease('source', { lockRoot: f.root, deadlineMs: 0 }, 'shared'))
    probe.fail = ''; probe.events = []; await error.cleanup.close()
    expect(probe.events).toEqual(['maintenance:attempt', 'maintenance:closed', 'writer:attempt', 'writer:closed'])
  } finally { probe.fail = ''; await error.cleanup.close() }
}, 15000)

it('closes the original generation handle before releasing the writer and retains both after file-close refusal', async () => {
  const f = await fixture(), close = Error('original generation close refused')
  let refuse = true, opens = 0
  const io = { ...nodeIo, async open(...args: Parameters<typeof nodeIo.open>) {
    const handle = await nodeIo.open(...args)
    if (args[0] === f.path && args[1] === 'r+') {
      opens++
      const original = handle.close.bind(handle)
      handle.close = async () => { probe.events.push('file:attempt'); if (refuse) throw close; await original(); probe.events.push('file:closed') }
    }
    return handle
  } }
  const log = await openCommitLog({ ...f.options, io }, 'write')
  probe.events = []
  try {
    const first = await Promise.allSettled([log.close()])
    expect(first[0]!.status).toBe('rejected')
    if (first[0]!.status === 'rejected') expect(contains(first[0]!.reason, close)).toBe(true)
    expect(probe.events).toEqual(['file:attempt']); expect(log.open).toBe(true)
    await blocked(() => acquireCommitLease('source', { lockRoot: f.root, deadlineMs: 0 }))
    refuse = false; probe.events = []; await log.close()
    expect(opens).toBe(1)
    expect(probe.events).toEqual(['file:attempt', 'file:closed', 'writer:attempt', 'writer:closed'])
    expect(log.open).toBe(false)
  } finally { refuse = false; await log.close() }
}, 15000)

it('single-flights a synchronously reentrant resource cleanup before calling the original file close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-resource-ledger-')); roots.push(root)
  const handle = await open(join(root, 'original.file'), 'w+'), original = handle.close.bind(handle), resources = new CommitLogResources()
  let nested: Promise<void> | undefined, calls = 0
  handle.close = async () => { calls++; if (calls === 1) nested = resources.close(); await original() }
  resources.file(handle)
  try { await resources.close(); await nested; expect(calls).toBe(1) }
  finally { await Promise.allSettled([resources.close(), ...(nested ? [nested] : [])]) }
}, 15000)
