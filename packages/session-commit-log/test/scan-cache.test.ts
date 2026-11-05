import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommitLog, openCommitLog } from '../src/index.ts'

const roots: string[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ih-scan-cache-'))
  roots.push(value)
  return value
}
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }) })
const options = (base: string) => ({ root: base, sessionId: 's1', now: () => new Date('2026-01-01T00:00:00.000Z'), lockRoot: base, lease: { retryMs: 10, deadlineMs: 2000 } })

describe('commit log scan cache', () => {
  it('reuses the parsed records for unchanged logs and reparses after an append', async () => {
    const base = await root()
    const header = { formatVersion: 15, sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z' }
    const created = await createCommitLog(options(base), { header, entries: [{ type: 'user/message', text: 'a' }] })
    await created.close()
    const first = await openCommitLog(options(base), 'read')
    try {
      expect(first.view().entries).toHaveLength(1)
      expect(first.view().header).toMatchObject({ sessionId: 's1' })
    } finally { await first.close() }
    const second = await openCommitLog(options(base), 'read')
    try { expect(second.view().entries).toHaveLength(1) } finally { await second.close() }
    const writer = await openCommitLog(options(base), 'write')
    try { await writer.append({ entries: [{ type: 'assistant/message', text: 'b' }] }) } finally { await writer.close() }
    const third = await openCommitLog(options(base), 'read')
    try {
      expect(third.view().entries).toHaveLength(2)
      expect(third.view().entries[1]).toMatchObject({ type: 'assistant/message', text: 'b' })
    } finally { await third.close() }
  })
})
