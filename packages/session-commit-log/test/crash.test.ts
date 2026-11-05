import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeIo, type CommitLogIo } from '../src/io.ts'
import { CommitLogNotFoundError, createCommitLog, openCommitLog } from '../src/store.ts'

const roots: string[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ih-commit-crash-'))
  roots.push(value)
  return value
}
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }) })

function handleFaultIo(fault: { syncThrows?: number; writeThrows?: number }): CommitLogIo {
  return {
    ...nodeIo,
    async open(file, flags) {
      const handle = await nodeIo.open(file, flags)
      let syncs = fault.syncThrows ?? 0, writes = fault.writeThrows ?? 0
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') return async () => { if (syncs > 0) { syncs--; throw new Error('cut') } return target.sync() }
          if (property === 'write') return async (...args: Parameters<typeof target.write>) => { if (writes > 0) { writes--; throw new Error('cut') } return (target.write as (...inner: typeof args) => Promise<unknown>)(...args) }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as typeof handle
    },
  }
}

const cuts: Array<[string, CommitLogIo]> = [
  ['temp open', { ...nodeIo, async open(file, flags) { if (flags === 'wx') throw new Error('cut'); return nodeIo.open(file, flags) } }],
  ['temp write', handleFaultIo({ writeThrows: 1 })],
  ['temp fsync', handleFaultIo({ syncThrows: 1 })],
  ['link', { ...nodeIo, async link() { throw new Error('cut') } }],
]

describe('crash cuts during birth', () => {
  for (const [name, io] of cuts) {
    it(`a cut at ${name} leaves no session`, async () => {
      const base = await root()
      await expect(createCommitLog({ root: base, sessionId: 's1', io }, { header: { sessionId: 's1' } })).rejects.toThrow()
      await expect(openCommitLog({ root: base, sessionId: 's1' }, 'read')).rejects.toBeInstanceOf(CommitLogNotFoundError)
      const directory = join(base, 's1')
      const names = await readdir(directory).catch(() => [] as string[])
      expect(names.filter(item => item.startsWith('session.v'))).toHaveLength(0)
    })
  }

  it('a cut after the link keeps the complete session', async () => {
    const base = await root()
    const io: CommitLogIo = { ...nodeIo, async unlink() { throw new Error('cut') } }
    const log = await createCommitLog({ root: base, sessionId: 's1', io }, { header: { sessionId: 's1' } })
    await log.close()
    const read = await openCommitLog({ root: base, sessionId: 's1' }, 'read')
    expect(read.records()).toHaveLength(1)
    await read.close()
  })
})
