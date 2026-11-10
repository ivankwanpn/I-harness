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

describe('commit log regressions', () => {
  it('serializes concurrent append, refresh and close while preserving snapshots', async () => {
    const base = await root()
    const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: {} })
    const before = log.view(), records = log.records()
    await Promise.all(Array.from({ length: 30 }, (_, i) => log.append({ entries: [{ type: 'test', i } as never] })))
    expect(before.entries).toHaveLength(0)
    expect(records).toHaveLength(1)
    expect(log.view().entries).toHaveLength(30)
    const append = log.append({ entries: [{ type: 'last' } as never] })
    const refresh = log.refresh()
    const close = log.close()
    await Promise.all([append, refresh, close])
    const read = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
    expect(read.records().map(r => r.seq)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1))
    await read.close()
  })
  it('validates before publication and supports a large initial history', async () => {
    const base = await root()
    await expect(createCommitLog({ root: base, sessionId: 's1' }, { header: {}, ops: [{ kind: 'rewind', toSeq: 1 }] })).rejects.toThrow()
    await expect(stat(path(base))).rejects.toMatchObject({ code: 'ENOENT' })
    const entries = Array.from({ length: 150000 }, () => ({ type: 'test' } as never))
    const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: {}, entries })
    await expect(log.append({ ops: [{ kind: 'rewind', toSeq: 150001 }] })).rejects.toThrow()
    await log.close()
    const read = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
    expect(read.view().entries).toHaveLength(150000)
    expect(read.records()).toHaveLength(1)
    await read.close()
  }, 30000)
  it('retains historical sidecars for readers and verifies content integrity', async () => {
    const base = await root()
    const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: {} })
    const old = await log.writeSidecar(Buffer.from('old'))
    await log.append({ ops: [{ kind: 'doc', key: 'x', side: old }] })
    const read = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
    await log.append({ ops: [{ kind: 'doc-clear', key: 'x' }] })
    await log.close()
    const write = await openCommitLog({ root: base, sessionId: 's1' }, 'write')
    expect(Buffer.from(await read.readSidecar(old.digest)).toString()).toBe('old')
    const { sidecarPath } = await import('../src/paths.ts')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(sidecarPath(base, 's1', old.digest), 'bad')
    await expect(read.readSidecar(old.digest)).rejects.toThrow(/integrity/)
    await read.close(); await write.close()
  })
  it('does not reuse cached history after same-size recreation', async () => {
    const base = await root()
    const options = { root: base, sessionId: 's1', now: () => new Date(0) }
    let log = await createCommitLog(options, { header: { value: 'a' } }); await log.close()
    let read = await openCommitLog(options, 'read'); expect(read.header().value).toBe('a'); await read.close()
    const { sessionDirectory } = await import('../src/paths.ts')
    await rm(sessionDirectory(base, 's1'), { recursive: true })
    log = await createCommitLog(options, { header: { value: 'b' } }); await log.close()
    read = await openCommitLog(options, 'read'); expect(read.header().value).toBe('b'); await read.close()
  })
})

it('poisons an uncertain writer until reopened', async () => {
  const base = await root()
  const first = await createCommitLog({ root: base, sessionId: 's1' }, { header: {} }); await first.close()
  const log = await openCommitLog({ root: base, sessionId: 's1', io: handleFaultIo({ syncThrows: 2 }) }, 'write')
  await expect(log.append({})).rejects.toThrow(/sync failure/)
  await expect(log.append({})).rejects.toThrow(/requires reopening/)
  await log.close()
  const reopened = await openCommitLog({ root: base, sessionId: 's1' }, 'write'); await reopened.append({}); await reopened.close()
})

it('derives inputs and checks preconditions inside the writer queue', async () => {
  const base = await root()
  const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: {} })
  const first = log.append(current => ({ entries: [{ type: 'test', seq: current.entryCount + 1 } as never] }))
  const second = log.append(current => ({ entries: [{ type: 'test', seq: current.entryCount + 1 } as never] }))
  const stale = log.append(current => { if (current.entryCount !== 0) throw new Error('stale prefix'); return {} })
  await expect(stale).rejects.toThrow('stale prefix')
  await Promise.all([first, second])
  expect(log.entryCount()).toBe(2)
  expect(log.view().entries.map(entry => (entry as unknown as { seq: number }).seq)).toEqual([1, 2])
  await log.close()
})

it('captures queued object inputs and sidecar bytes at admission and closes admission immediately', async () => {
  const base = await root()
  const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: {} })
  const input = { entries: [{ type: 'test', nested: { text: 'before' } } as never], ops: [{ kind: 'meta' as const, patch: { value: 'before' } }] }
  const bytes = new Uint8Array([1, 2, 3])
  const first = log.append(() => { expect(log.open).toBe(true); return {} })
  const append = log.append(input)
  const sidecar = log.writeSidecar(bytes)
  ;(input.entries[0] as unknown as { nested: { text: string } }).nested.text = 'after'
  input.ops[0]!.patch.value = 'after'
  bytes.fill(9)
  const close = log.close()
  expect(log.close()).toBe(close)
  expect(log.open).toBe(true)
  await expect(log.append({})).rejects.toMatchObject({ code: 'COMMIT_LOG_CLOSED' })
  await expect(log.writeSidecar(bytes)).rejects.toMatchObject({ code: 'COMMIT_LOG_CLOSED' })
  await Promise.all([first, append, sidecar, close])
  expect(log.open).toBe(false)
  const read = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
  expect(read.view().entries[0]).toMatchObject({ nested: { text: 'before' } })
  expect(read.view().meta.value).toBe('before')
  expect(await read.readSidecar((await sidecar).digest)).toEqual(new Uint8Array([1, 2, 3]))
  await read.close()
})

it('writes only appended deltas without rereading or materializing history', async () => {
  const base = await root()
  const initial = await createCommitLog({ root: base, sessionId: 's1' }, { header: {}, entries: Array.from({ length: 10000 }, () => ({ type: 'test', text: 'history' } as never)) })
  await initial.close()
  let reads = 0, written = 0
  const io: CommitLogIo = { ...nodeIo,
    async readFile(file) { reads++; return nodeIo.readFile(file) },
    async open(file, flags) {
      const handle = await nodeIo.open(file, flags)
      return new Proxy(handle, { get(target, key) {
        if (key === 'write') return async (...args: Parameters<typeof target.write>) => { const result = await (target.write as (...values: typeof args) => ReturnType<typeof target.write>)(...args); written += result.bytesWritten; return result }
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
      } })
    },
  }
  const log = await openCommitLog({ root: base, sessionId: 's1', io }, 'write')
  reads = 0
  for (let i = 0; i < 100; i++) await log.append({ entries: [{ type: 'delta', i } as never] })
  expect(reads).toBe(0)
  expect(written).toBeLessThan(100 * 1024)
  expect(log.entryCount()).toBe(10100)
  await log.close()
})

it('preserves the durable tombstone when recreation publication fails', async () => {
  const base = await root()
  const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: { incarnation: 'old' } })
  await log.append({ ops: [{ kind: 'delete' }] }); await log.close()
  const before = await readFile(path(base))
  const io: CommitLogIo = { ...nodeIo, async rename() { throw new Error('injected replacement failure') } }
  await expect(createCommitLog({ root: base, sessionId: 's1', recreateDeleted: true, io }, { header: { incarnation: 'new' } })).rejects.toThrow('replacement failure')
  expect(await readFile(path(base))).toEqual(before)
  const deleted = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
  expect(deleted.view().deleted).toBe(true); await deleted.close()
  const recreated = await createCommitLog({ root: base, sessionId: 's1', recreateDeleted: true }, { header: { incarnation: 'new' } })
  expect(recreated.header().incarnation).toBe('new'); await recreated.close()
})
it('releases the writer lease when collection fails before opening the generation handle', async () => {
  const base = await root()
  const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: {} }); await log.close()
  let closed = 0
  const io: CommitLogIo = { ...nodeIo,
    async readdir() { throw new Error('injected collection failure') },
    async open(file, flags) {
      const handle = await nodeIo.open(file, flags)
      if (flags !== 'r+') return handle
      return new Proxy(handle, { get(target, key) {
        if (key === 'close') return async () => { closed++; await target.close() }
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
      } })
    },
  }
  await expect(openCommitLog({ root: base, sessionId: 's1', io }, 'write')).rejects.toThrow('collection failure')
  expect(closed).toBe(0)
  const reopened = await openCommitLog({ root: base, sessionId: 's1', lease: { deadlineMs: 100 } }, 'write'); await reopened.close()
})

it('closes the opened generation handle when torn-tail repair fails', async () => {
  const base = await root()
  const log = await createCommitLog({ root: base, sessionId: 's1' }, { header: {} }); await log.close()
  await appendFile(path(base), '{"incomplete":')
  let closed = 0
  const io: CommitLogIo = { ...nodeIo, async open(file, flags) {
    const handle = await nodeIo.open(file, flags)
    if (flags !== 'r+') return handle
    return new Proxy(handle, { get(target, key) {
      if (key === 'truncate') return async () => { throw Error('injected repair failure') }
      if (key === 'close') return async () => { closed++; await target.close() }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
  await expect(openCommitLog({ root: base, sessionId: 's1', io }, 'write')).rejects.toThrow('repair failure')
  expect(closed).toBe(1)
  const reopened = await openCommitLog({ root: base, sessionId: 's1', lease: { deadlineMs: 100 } }, 'write')
  await reopened.close()
})

it('retries a failed original close without reopening mutation admission', async () => {
  const base = await root()
  let attempts = 0
  const io: CommitLogIo = { ...nodeIo, async open(file, flags) {
    const handle = await nodeIo.open(file, flags)
    if (flags !== 'r+') return handle
    return new Proxy(handle, { get(target, key) {
      if (key === 'close') return async () => { if (++attempts === 1) throw new Error('injected original close failure'); await target.close() }
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
  const log = await createCommitLog({ root: base, sessionId: 's1', io }, { header: {} })
  await expect(log.close()).rejects.toThrow('original close failure')
  expect(log.open).toBe(true)
  await expect(openCommitLog({ root: base, sessionId: 's1', lease: { deadlineMs: 50, retryMs: 5 } }, 'write')).rejects.toBeInstanceOf(SessionLockConflictError)
  await expect(log.append({})).rejects.toMatchObject({ code: 'COMMIT_LOG_CLOSED' })
  await log.close()
  expect(attempts).toBe(2); expect(log.open).toBe(false)
})
