import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'

const roots: string[] = []
const coordinators: Array<ReturnType<typeof createCommitCoordinator>> = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-obs-'))
  roots.push(root)
  const coordinator = createCommitCoordinator({ root })
  coordinators.push(coordinator)
  return { root, coordinator }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const bindingKey = (id: string) => `desktop-session-project-${createHash('sha256').update(id).digest('hex')}`

describe('commit-log binding observations', () => {
  it('exposes metadata and an absent binding for existing sessions', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    const result = await coordinator.withExistingSessionBindingObservation({ sessionIds: ['s1'] }, async observation => {
      expect(observation.metadata('s1')).toMatchObject({ sessionId: 's1' })
      expect(observation.binding('s1')).toEqual({ kind: 'absent' })
      observation.assertCurrent()
      return 'done'
    })
    expect(result).toBe('done')
  })

  it('reports a present binding and the not-yet-born target as absent', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    await coordinator.putDocument(bindingKey('s1'), { kind: 'binding', value: 1 })
    await coordinator.withExistingSessionBindingObservation({ sessionIds: ['s1'] }, async observation => {
      expect(observation.binding('s1')).toEqual({ kind: 'present', value: { kind: 'binding', value: 1 } })
    })
    await coordinator.withSessionBindingObservation({ existingSessionIds: ['s1'], target: { version: 1, operationId: 'op', targetSessionId: 'child', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) } }, async observation => {
      expect(observation.metadata('s1')).toMatchObject({ sessionId: 's1' })
      expect(observation.binding('child')).toEqual({ kind: 'absent' })
    })
  })

  it('refuses when metadata or the binding changed during the callback', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    await expect(coordinator.withExistingSessionBindingObservation({ sessionIds: ['s1'] }, async () => {
      await coordinator.updateMeta('s1', { title: 'changed' })
    })).rejects.toMatchObject({ reason: 'conflict' })

    await expect(coordinator.withSessionBindingObservation({ existingSessionIds: ['s1'], target: { version: 1, operationId: 'op', targetSessionId: 'child', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) } }, async () => {
      await coordinator.putDocument(bindingKey('child'), { bound: true })
    })).rejects.toMatchObject({ reason: 'conflict' })
  })

  it('refuses an unavailable existing session and a revoked observation', async () => {
    const { coordinator } = await setup()
    await expect(coordinator.withExistingSessionBindingObservation({ sessionIds: ['missing'] }, async () => {})).rejects.toMatchObject({ reason: 'unavailable' })
    await coordinator.create({ sessionId: 's1' })
    const controller = new AbortController()
    await expect(coordinator.withExistingSessionBindingObservation({ sessionIds: ['s1'], signal: controller.signal }, async observation => {
      controller.abort()
      observation.assertCurrent()
    })).rejects.toMatchObject({ reason: 'revoked' })
  })
})
