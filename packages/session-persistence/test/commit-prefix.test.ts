import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_FORMAT_VERSION, stringifyJsonData, type SessionEvent } from '@i-harness/core-session'
import { createCommitLog, openCommitLog } from '@i-harness/session-commit-log'
import { commitPrefix } from '../src/commit/managed.ts'

const roots: string[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ih-prefix-'))
  roots.push(value)
  return value
}
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }) })
const options = (base: string) => ({ root: base, sessionId: 's1', now: () => new Date('2026-01-01T00:00:00.000Z'), lockRoot: base, lease: { retryMs: 10, deadlineMs: 2000 } })
const bytesOf = (events: readonly SessionEvent[]) => events.reduce((sum, event) => sum + Buffer.byteLength(stringifyJsonData(event) ?? 'null'), 0)

describe('commit prefix', () => {
  it('accumulates body bytes exactly across appends', async () => {
    const base = await root()
    const header = { formatVersion: CURRENT_FORMAT_VERSION, sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z' }
    const log = await createCommitLog(options(base), { header, entries: [] })
    try {
      expect(commitPrefix(log)).toMatchObject({ eventCount: 0, bodyBytes: 0 })
      const first: SessionEvent[] = [{ type: 'user/message', text: 'a' }]
      await log.append({ entries: first })
      expect(commitPrefix(log)).toMatchObject({ eventCount: 1, bodyBytes: bytesOf(first) })
      const second: SessionEvent[] = [{ type: 'assistant/message', text: 'b' }, { type: 'turn/end' }]
      await log.append({ entries: second })
      expect(commitPrefix(log)).toMatchObject({ eventCount: 3, bodyBytes: bytesOf([...first, ...second]) })
      // Repeated reads must not change the value.
      expect(commitPrefix(log)).toEqual(commitPrefix(log))
    } finally { await log.close() }
    const reopened = await openCommitLog(options(base), 'read')
    try {
      expect(commitPrefix(reopened)).toMatchObject({ eventCount: 3, bodyBytes: bytesOf([{ type: 'user/message', text: 'a' }, { type: 'assistant/message', text: 'b' }, { type: 'turn/end' }]) })
    } finally { await reopened.close() }
  })
})
