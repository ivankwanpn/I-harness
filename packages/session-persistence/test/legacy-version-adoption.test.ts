import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'

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
  const events = [
    { type: 'turn/start' }, { type: 'step/start' },
    { type: 'user/message', text: 'hello' }, { type: 'assistant/message', text: 'hi' },
    { type: 'step/end' }, { type: 'turn/end' },
  ].map((event, seq) => ({ ...event, seq }))
  return {
    async read(sessionId: string) {
      if (sessionId !== id) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return { version, events: events as never[], meta: { formatVersion: version, sessionId: id, createdAt: '2026-01-01T00:00:00.000Z', journal: { version: 1 } } }
    },
    async list() { return [id] },
  }
}

describe('legacy version adoption', () => {
  for (const version of [6, 8, 11, 13, 14]) {
    it(`adopts a format-${version} session and migrates it on the first write`, async () => {
      const root = await mkdtemp(join(tmpdir(), `ih-legacy-v${version}-`))
      roots.push(root)
      const coordinator = createCommitCoordinator({ root, legacy: legacy(version, 'old') as never })
      coordinators.push(coordinator)
      const loaded = await coordinator.load('old')
      expect(loaded.session.events).toHaveLength(6)
      await coordinator.append('old', [{ type: 'user/message', text: 'after migration' }] as never)
      const migrated = await coordinator.load('old')
      expect(migrated.session.events).toHaveLength(7)
      expect((await coordinator.profile('old')).meta.formatVersion).toBe(CURRENT_FORMAT_VERSION)
    })
  }
})