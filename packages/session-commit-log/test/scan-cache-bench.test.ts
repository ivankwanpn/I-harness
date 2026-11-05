import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommitLog, openCommitLog } from '../src/index.ts'

const roots: string[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ih-scan-bench-'))
  roots.push(value)
  return value
}
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }) })
const options = (base: string, sessionId: string) => ({ root: base, sessionId, now: () => new Date('2026-01-01T00:00:00.000Z'), lockRoot: base, lease: { retryMs: 10, deadlineMs: 2000 } })

describe('commit log read benchmark', () => {
  it('profiles a many-session store', async () => {
    const base = await root()
    const ids: string[] = []
    for (let index = 0; index < 40; index++) {
      const id = 's' + index
      ids.push(id)
      const events = Array.from({ length: 30 }, (_, at) => ({ type: at % 2 === 0 ? 'user/message' : 'assistant/message', text: 'event ' + at + ' ' + 'x'.repeat(200) }))
      const log = await createCommitLog(options(base, id), { header: { formatVersion: 15, sessionId: id, createdAt: '2026-01-01T00:00:00.000Z' }, entries: events })
      await log.close()
    }
    const readAll = async () => {
      for (const id of ids) {
        const log = await openCommitLog(options(base, id), 'read')
        try { if (log.view().entries.length !== 30) throw new Error('unexpected event count') } finally { await log.close() }
      }
    }
    await readAll()
    const started = performance.now()
    await readAll()
    const elapsed = Math.round(performance.now() - started)
    console.log('[bench] profile 40 sessions x 30 events:', elapsed + 'ms')
    expect(elapsed).toBeGreaterThan(0)
  }, 60000)
})
