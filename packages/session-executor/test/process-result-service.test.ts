import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createProcessAwareResultService, lookupProcessResultService } from '../src/lifecycle/process-result-service.ts'

it('creates its own real result service and preserves generic page scope behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-service-')), coordinator = createSessionCoordinator(createJsonlBackend(root))
  const owner = createProcessAwareResultService({ root, workspaceId: 'w', coordinatorFor: () => coordinator, sourceFor: async () => ({ sourceId: 's', readonly: true }), genericVisible: async () => false })
  try {
    expect(lookupProcessResultService(owner.service)).toBeDefined()
    expect(lookupProcessResultService({ ...owner.service })).toBeUndefined()
    expect(await owner.withPage(coordinator, 's', () => true, async () => 'ok')).toBe('ok')
    owner.retireBridge()
    await expect(owner.withPage(coordinator, 's', () => true, async () => 'bad')).rejects.toThrow()
  } finally { await owner.service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
