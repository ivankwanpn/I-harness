import { expect, it } from 'vitest'
import { createSessionCoordinator } from '../src/index.ts'

it('refuses managed activation without actual exclusive ownership and owned batch backend', async () => {
  const backend = { id: 'jsonl', capabilities: { seekableRead: false, rawArtifacts: false } } as any
  const coordinator = createSessionCoordinator(backend)
  await expect(coordinator.openManagedDocument('s')).rejects.toMatchObject({ code: 'FACT_OWNER_UNSUPPORTED' })
})
