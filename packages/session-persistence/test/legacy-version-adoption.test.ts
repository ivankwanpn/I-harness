import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_FORMAT_VERSION, type SessionEvent } from '@i-harness/core-session'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import type { LegacySession, LegacySessionStore } from '../src/commit/legacy.ts'

const roots: string[] = []
const coordinators: Array<ReturnType<typeof createCommitCoordinator>> = []
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

// The upgrade chain 1..13 is identity today, so a legacy session at any of
// these versions must be adoptable by the commit log: readable through the
// legacy store and migrated into a format-15 generation on the first write.
// Recorded samples are still needed for the byte layouts; this pins the
// coordinator contract for the versions themselves.
function legacy(version: number, id: string) {
  const events: SessionEvent[] = [
    { type: 'turn/start' }, { type: 'step/start' },
    { type: 'user/message', text: 'hello' }, { type: 'assistant/message', text: 'hi' },
    { type: 'step/end' }, { type: 'turn/end' },
  ]
  // This logical-version fixture owns immutable input and exposes no writer.
  // Each read and migration receives its own data; physical layouts are
  // qualified separately by the original JSONL migration tests.
  const records = Object.freeze(events.map((event, seq) => Object.freeze({ ...event, seq })))
  const meta = Object.freeze({ formatVersion: version, sessionId: id, createdAt: '2026-01-01T00:00:00.000Z' })
  const store: LegacySessionStore = {
    async read(sessionId: string): Promise<LegacySession> {
      if (sessionId !== id) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return { version, events: records.map(event => ({ ...event })), meta: { ...meta } }
    },
    async list() { return [id] },
    async migrate<T>(sessionId: string, publish: (source: LegacySession | undefined) => Promise<T>): Promise<T> {
      return publish(sessionId === id ? await store.read(id) : undefined)
    },
  }
  return store
}

describe('legacy version adoption', () => {
  for (const version of [6, 8, 11, 13, 14]) {
    it(`adopts a format-${version} session and migrates it on the first write`, async () => {
      const root = await mkdtemp(join(tmpdir(), `ih-legacy-v${version}-`))
      roots.push(root)
      const original = legacy(version, 'old')
      const before = await original.read('old')
      const coordinator = createCommitCoordinator({ root, legacy: original })
      coordinators.push(coordinator)
      const loaded = await coordinator.load('old')
      expect(loaded.session.events).toHaveLength(6)
      await coordinator.append('old', [{ type: 'user/message', text: 'after migration' }])
      const migrated = await coordinator.load('old')
      expect(migrated.session.events).toHaveLength(7)
      expect((await coordinator.profile('old')).meta.formatVersion).toBe(CURRENT_FORMAT_VERSION)
      expect(await original.read('old')).toEqual(before)
    })
  }
})
