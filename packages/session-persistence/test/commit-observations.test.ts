import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import { createCommitObservations } from '../src/commit/observations.ts'
import type { ExistingSessionBindingObservation } from '../src/coordinator/types.ts'

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
  it.each([false, undefined, null, 0, ''])('revokes an escaped observation after the original callback throws %s', async failure => {
    const observations = createCommitObservations({
      async profile(id) { return { meta: { sessionId: id, formatVersion: 15, createdAt: '2026-11-01T00:00:00.000Z' }, blank: true } },
      async getDocument() { return undefined },
    })
    let escaped!: ExistingSessionBindingObservation
    await expect(observations.withExistingSessionBindingObservation({ sessionIds: ['s1'] }, async observation => {
      escaped = observation
      throw failure
    })).rejects.toBe(failure)
    expect(() => escaped.assertCurrent()).toThrow(expect.objectContaining({ reason: 'revoked' }))
    expect(() => escaped.metadata('s1')).toThrow(expect.objectContaining({ reason: 'revoked' }))
    expect(() => escaped.binding('s1')).toThrow(expect.objectContaining({ reason: 'revoked' }))
  })

  it('owns immutable metadata and binding snapshots without freezing the reader port values', async () => {
    const meta = { sessionId: 's1', formatVersion: 15, createdAt: '2026-11-01T00:00:00.000Z', modelSelection: { provider: 'p', model: 'm' } }
    const binding = { version: 1, projectId: 'p', extra: { revision: 1 } }
    const observations = createCommitObservations({ async profile() { return { meta, blank: true } }, async getDocument() { return binding } })
    await observations.withExistingSessionBindingObservation({ sessionIds: ['s1'] }, async observation => {
      const savedMeta = observation.metadata('s1'), savedBinding = observation.binding('s1')
      expect(savedMeta).not.toBe(meta)
      expect(savedMeta.modelSelection).not.toBe(meta.modelSelection)
      expect(Object.isFrozen(savedMeta.modelSelection)).toBe(true)
      if (savedBinding.kind !== 'present') throw Error('Expected actual present binding')
      expect(savedBinding.value).not.toBe(binding)
      expect(Object.isFrozen(savedBinding.value)).toBe(true)
      expect(Reflect.set(savedBinding.value as object, 'projectId', 'forged')).toBe(false)
    })
    expect(Object.isFrozen(meta)).toBe(false)
    expect(Object.isFrozen(meta.modelSelection)).toBe(false)
    expect(Object.isFrozen(binding)).toBe(false)
  })

  it.each([false, undefined])('revokes the actual native observation after its callback throws %s', async failure => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    let escaped!: ExistingSessionBindingObservation
    await expect(coordinator.withExistingSessionBindingObservation({ sessionIds: ['s1'] }, async observation => {
      escaped = observation
      throw failure
    })).rejects.toBe(failure)
    expect(() => escaped.assertCurrent()).toThrow(expect.objectContaining({ reason: 'revoked' }))
    expect(() => escaped.metadata('s1')).toThrow(expect.objectContaining({ reason: 'revoked' }))
    expect(() => escaped.binding('s1')).toThrow(expect.objectContaining({ reason: 'revoked' }))
  })

  it.each(['metadata', 'binding'] as const)('cannot hide a real persisted %s change by mutating the expected snapshot', async kind => {
    const { root, coordinator } = await setup()
    const writer = createCommitCoordinator({ root })
    coordinators.push(writer)
    await coordinator.create({ sessionId: 's1', title: 'old' })
    await coordinator.putDocument(bindingKey('s1'), { version: 1, projectId: 'old' })
    let changedSnapshot = false
    const observed = await coordinator.withExistingSessionBindingObservation({ sessionIds: ['s1'] }, async observation => {
      if (kind === 'metadata') {
        const before = observation.metadata('s1')
        await writer.updateMeta('s1', { title: 'new' })
        changedSnapshot = Reflect.set(before, 'title', 'new')
      } else {
        const before = observation.binding('s1')
        if (before.kind !== 'present' || !before.value || typeof before.value !== 'object') throw Error('Expected actual binding data')
        await writer.putDocument(bindingKey('s1'), { version: 1, projectId: 'new' })
        changedSnapshot = Reflect.set(before.value, 'projectId', 'new')
      }
      return 'must not publish'
    }).then(value => ({ value }), error => ({ error }))
    expect(observed).toMatchObject({ error: { reason: 'conflict' } })
    expect(changedSnapshot).toBe(false)
  })

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
