import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_FORMAT_VERSION, type SessionEvent } from '@i-harness/core-session'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlCommitCoordinator } from '../src/commit-coordinator.ts'

const roots: string[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ih-commit-dual-'))
  roots.push(value)
  return value
}
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }) })

const meta = (sessionId: string) => ({ sessionId, createdAt: '2026-01-01T00:00:00.000Z', formatVersion: CURRENT_FORMAT_VERSION })
const events = (): SessionEvent[] => [
  { type: 'turn/start', turnId: 't1' } as SessionEvent,
  { type: 'user/message', text: 'hello' } as SessionEvent,
  { type: 'turn/end', turnId: 't1' } as SessionEvent,
]

describe('commit coordinator dual-run against the legacy backend', () => {
  it('loads the same events and metadata as the legacy store', async () => {
    const base = await root()
    const backend = createJsonlBackend(base)
    await backend.create('s1', meta('s1'))
    await backend.append('s1', events())
    await backend.updateMeta('s1', { title: 'parity' })
    const legacy = await backend.read('s1')

    const coordinator = createJsonlCommitCoordinator(base)
    try {
      const { session } = await coordinator.load('s1')
      expect(session.events).toEqual(legacy.events)
      expect(session.formatVersion).toBe(CURRENT_FORMAT_VERSION)
      const profile = await coordinator.profile('s1')
      expect(profile.meta.title).toBe('parity')
      expect(await coordinator.list()).toEqual(await backend.list())
      expect(await coordinator.list()).toEqual(['s1'])
    } finally { await coordinator.close() }
  })

  it('keeps parity for an empty session', async () => {
    const base = await root()
    const backend = createJsonlBackend(base)
    await backend.create('empty', meta('empty'))
    const coordinator = createJsonlCommitCoordinator(base)
    try {
      const { session } = await coordinator.load('empty')
      expect(session.events).toEqual([])
      expect((await coordinator.profile('empty')).blank).toBe(true)
    } finally { await coordinator.close() }
  })
})
