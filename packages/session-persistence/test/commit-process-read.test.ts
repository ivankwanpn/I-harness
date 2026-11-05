import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'

const roots: string[] = []
const coordinators: Array<ReturnType<typeof createCommitCoordinator>> = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-read-'))
  roots.push(root)
  const coordinator = createCommitCoordinator({ root })
  coordinators.push(coordinator)
  return { root, coordinator }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('commit-log process reads', () => {
  it('captures a fold, reports appended suffixes and publishes the result', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    await coordinator.append('s1', [{ type: 'user/message', text: 'a' }])
    const result = await coordinator.withProcessReadObservation(
      's1',
      { documentKeys: ['missing-key'] },
      async observation => {
        expect(observation.initial.highWater).toBe(1)
        expect(observation.initial.session.events).toHaveLength(1)
        expect(observation.initial.documents.get('missing-key')).toEqual({ kind: 'absent' })
        await coordinator.append('s1', [{ type: 'user/message', text: 'b' }])
        const update = await observation.check()
        expect(update).toMatchObject({ kind: 'suffix', from: 1, to: 2 })
        observation.assertCurrent()
        return 'work'
      },
      async (candidate, _observation, last) => {
        expect(candidate).toBe('work')
        expect(last).toMatchObject({ kind: 'unchanged', highWater: 2 })
        return 'published'
      },
    )
    expect(result).toBe('published')
  })

  it('refuses after the observation is released', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    let captured: import('../src/coordinator/process-read-owner.ts').ProcessReadObservation | undefined
    await coordinator.withProcessReadObservation('s1', { documentKeys: [] }, async observation => {
      captured = observation
      observation.assertCurrent()
    }, async candidate => candidate)
    expect(() => captured!.assertCurrent()).toThrow(/PROCESS_READ_UNAVAILABLE/)
  })
})
