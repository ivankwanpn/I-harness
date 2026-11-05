import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlCommitCoordinator } from '../src/commit-coordinator.ts'

const roots: string[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ih-commit-jsonl-'))
  roots.push(value)
  return value
}
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }) })

async function legacySession(base: string): Promise<string> {
  const backend = createJsonlBackend(base)
  const meta = { sessionId: 'legacy', createdAt: '2026-01-01T00:00:00.000Z', formatVersion: CURRENT_FORMAT_VERSION }
  await backend.create('legacy', meta)
  await backend.append('legacy', [{ type: 'user/message', text: 'old', seq: 0 }])
  return join(base, 'legacy.jsonl')
}

describe('jsonl commit coordinator', () => {
  it('reads a legacy session and migrates it on write without touching the old bytes', async () => {
    const base = await root()
    const legacyPath = await legacySession(base)
    const before = await readFile(legacyPath)

    const coordinator = createJsonlCommitCoordinator(base)
    try {
      const loaded = await coordinator.load('legacy')
      expect(loaded.session.events).toEqual([{ type: 'user/message', text: 'old', seq: 0 }])
      expect(await stat(join(base, 'legacy')).then(() => true, () => false)).toBe(false)

      await coordinator.append('legacy', [{ type: 'user/message', text: 'new' }])
      expect(await stat(join(base, 'legacy', 'session.v15.jsonl')).then(() => true, () => false)).toBe(true)
      expect(await readFile(legacyPath)).toEqual(before)

      const after = await coordinator.load('legacy')
      expect(after.session.events.map(event => (event as { text?: string }).text)).toEqual(['old', 'new'])
    } finally { await coordinator.close() }
  })

  it('creates, lists and reloads a format-15 session through the jsonl root', async () => {
    const base = await root()
    const coordinator = createJsonlCommitCoordinator(base)
    try {
      await coordinator.create({ sessionId: 'fresh' })
      await coordinator.append('fresh', [{ type: 'user/message', text: 'hello' }])
      expect(await coordinator.list()).toEqual(['fresh'])
      const { session } = await coordinator.load('fresh')
      expect(session.events).toEqual([{ type: 'user/message', text: 'hello', seq: 0 }])
    } finally { await coordinator.close() }
  })
})
