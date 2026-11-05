import { mkdtemp, appendFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommitLogConflictError, CommitLogNotFoundError, createCommitLog, openCommitLog } from '../src/store.ts'
import { SessionLockConflictError } from '@i-harness/fs-lock'
import { nodeIo, type CommitLogIo } from '../src/io.ts'
import { generationPath } from '../src/paths.ts'
import { COMMIT_LOG_GENERATION } from '../src/store.ts'

const roots: string[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ih-commit-log-'))
  roots.push(value)
  return value
}
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }) })

const path = (root: string, id = 's1') => generationPath(root, id, COMMIT_LOG_GENERATION)

function handleFaultIo(fault: { syncThrows?: number; writeThrows?: number }): CommitLogIo {
  return {
    ...nodeIo,
    async open(file, flags) {
      const handle = await nodeIo.open(file, flags)
      let syncs = fault.syncThrows ?? 0, writes = fault.writeThrows ?? 0
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') return async () => { if (syncs > 0) { syncs--; throw new Error('injected sync failure') } return target.sync() }
          if (property === 'write') return async (...args: Parameters<typeof target.write>) => { if (writes > 0) { writes--; throw new Error('injected write failure') } return (target.write as (...inner: typeof args) => Promise<unknown>)(...args) }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as typeof handle
    },
  }
}

describe('commit log store', () => {
  it('publishes a new session and reopens it for read', async () => {
    const base = await root()
    const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: { sessionId: 's1', createdAt: 'c' } })
    expect(log.mode).toBe('write')
    await log.append({ entries: [{ type: 'user/message', text: 'hi' } as never] })
    await log.close()

    const read = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
    expect(read.header()).toEqual({ sessionId: 's1', createdAt: 'c' })
    expect(read.records().map(record => record.seq)).toEqual([1, 2])
    expect(read.view().entries).toEqual([{ type: 'user/message', text: 'hi' }])
    await read.close()
  })

  it('refuses to create the same session twice', async () => {
    const base = await root()
    const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: { sessionId: 's1' } })
    await log.close()
    await expect(createCommitLog({ root: base, sessionId: 's1' }, { header: { sessionId: 's1' } })).rejects.toBeInstanceOf(CommitLogConflictError)
  })

  it('reports a missing session', async () => {
    const base = await root()
    await expect(openCommitLog({ root: base, sessionId: 'missing' }, 'read')).rejects.toBeInstanceOf(CommitLogNotFoundError)
  })

  it('drops a torn tail on open and truncates it before the next append', async () => {
    const base = await root()
    const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: { sessionId: 's1' } })
    await log.append({ entries: [{ type: 'a' } as never] })
    await log.close()
    await appendFile(path(base), '{"v":15,"seq":3')
    const before = (await stat(path(base))).size

    const read = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
    expect(read.records()).toHaveLength(2)
    await read.close()
    expect((await stat(path(base))).size).toBe(before)

    const write = await openCommitLog({ root: base, sessionId: 's1' }, 'write')
    expect((await stat(path(base))).size).toBeLessThan(before)
    const record = await write.append({ entries: [{ type: 'b' } as never] })
    expect(record.seq).toBe(3)
    await write.close()

    const reopened = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
    expect(reopened.records().map(r => r.seq)).toEqual([1, 2, 3])
    await reopened.close()
  })

  it('rolls an append back to the previous size when the fsync fails', async () => {
    const base = await root()
    const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: { sessionId: 's1' } })
    await log.close()
    const before = await readFile(path(base))
    const faulty = handleFaultIo({ syncThrows: 1 })
    const write = await openCommitLog({ root: base, sessionId: 's1', io: faulty }, 'write')
    await expect(write.append({ entries: [{ type: 'a' } as never] })).rejects.toThrow(/injected sync failure/)
    await write.close()
    expect(await readFile(path(base))).toEqual(before)
    const reopened = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
    expect(reopened.records()).toHaveLength(1)
    await reopened.close()
  })

  it('keeps sidecars content-addressed and collects unreferenced ones', async () => {
    const base = await root()
    const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: { sessionId: 's1' } })
    const kept = await log.writeSidecar(new TextEncoder().encode('first'))
    const orphan = await log.writeSidecar(new TextEncoder().encode('second'))
    await log.append({ ops: [{ kind: 'doc', key: 'task', side: kept }] })
    await log.close()

    const write = await openCommitLog({ root: base, sessionId: 's1' }, 'write')
    expect(new TextDecoder().decode(await write.readSidecar(kept.digest))).toBe('first')
    await expect(write.readSidecar(orphan.digest)).rejects.toMatchObject({ code: 'ENOENT' })
    await write.close()
  })

  it('refuses a second writer while the lease is held', async () => {
    const base = await root()
    const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: { sessionId: 's1' } })
    await expect(openCommitLog({ root: base, sessionId: 's1', lease: { deadlineMs: 80, retryMs: 5 } }, 'write')).rejects.toBeInstanceOf(SessionLockConflictError)
    await log.close()
    const reopened = await openCommitLog({ root: base, sessionId: 's1', lease: { deadlineMs: 80, retryMs: 5 } }, 'write')
    await reopened.close()
  })
})
