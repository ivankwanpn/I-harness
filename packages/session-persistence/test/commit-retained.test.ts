import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { preflightRetainedCoordinatorFor } from '../src/coordinator/retained-binding.ts'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'

const roots: string[] = []
const coordinators: Array<ReturnType<typeof createCommitCoordinator>> = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-retained-'))
  roots.push(root)
  const coordinator = createCommitCoordinator({ root })
  coordinators.push(coordinator)
  return { root, coordinator }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('commit-log retained bindings', () => {
  it('issues, reads and releases a retained session binding', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    const facade = asSessionCoordinator(coordinator)
    preflightRetainedCoordinatorFor(facade)
    const retired: unknown[] = []
    const reference = await facade.retainExistingSessionBindingObservation!({ sessionId: 's1' }, operation => { retired.push(operation) })
    reference.assertCurrent()
    expect(reference.metadata().sessionId).toBe('s1')
    expect(reference.binding()).toEqual({ kind: 'absent' })
    const profile = await reference.withRead(async read => read())
    expect(profile.meta.sessionId).toBe('s1')
    await reference.release()
    expect(() => reference.assertCurrent()).toThrow()
  })

  it('revokes a retained reference when the coordinator closes', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's3' })
    const facade = asSessionCoordinator(coordinator)
    const reference = await facade.retainExistingSessionBindingObservation!({ sessionId: 's3' }, () => {})
    reference.assertCurrent()
    await coordinator.close()
    expect(() => reference.assertCurrent()).toThrow()
  })

  it('revokes a retained reference when its session is deleted', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's2' })
    await coordinator.putDocument('task-s2', { formatVersion: 2, tasks: [], notifications: [] })
    const facade = asSessionCoordinator(coordinator)
    const reference = await facade.retainExistingSessionBindingObservation!({ sessionId: 's2' }, () => {})
    reference.assertCurrent()
    await coordinator.deleteOwnedSession('s2', { documents: ['task-s2'] })
    expect(() => reference.assertCurrent()).toThrow()
    await reference.release()
  })
})