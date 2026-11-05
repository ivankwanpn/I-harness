import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedExecutionDomain } from '@i-harness/core-session/internal/execution'
import { acquireManagedExecution } from '../src/execution-internal.ts'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'

const roots: string[] = []
const coordinators: Array<ReturnType<typeof createCommitCoordinator>> = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-exec-'))
  roots.push(root)
  const coordinator = createCommitCoordinator({ root })
  coordinators.push(coordinator)
  return { root, coordinator }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('commit-log managed execution', () => {
  it('acquires an attachment whose owner is the managed document', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    const facade = asSessionCoordinator(coordinator)
    const attachment = await acquireManagedExecution(facade, 's1')
    try {
      expect(attachment.identity).toBeDefined()
      expect(attachment.owner).toBe(await coordinator.openManagedDocument('s1'))
      const observation = attachment.observe()
      expect(observation.eventCount).toBe(0)
      expect(observation.formatVersion).toBeGreaterThanOrEqual(14)
      const domain = createManagedExecutionDomain(attachment.identity, attachment.owner as never, {})
      expect(domain.identity).toBe(attachment.identity)
    } finally {
      await attachment.close()
    }
  })
})
