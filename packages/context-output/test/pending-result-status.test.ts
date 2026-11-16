import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createContextOutputService } from '../src/index.ts'
import { unfinishedResult } from './close-fixture.ts'

it('reports an open original result sink as pending and releases it on refusal', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'context-pending-result-'))
  const service = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true }, documentDeletions: () => () => {} })
  try {
    expect(service.status().pendingResults).toBe(0)
    const original = await unfinishedResult(service, root, 'pending-status')
    expect(service.status().pendingResults).toBe(1)
    await original.sink.refuse?.('capture-canceled')
    expect(service.status().pendingResults).toBe(0)
    await original.body.close().catch(() => {})
    await original.leaves.close().catch(() => {})
  } finally {
    await service.close()
    await rm(root, { recursive: true, force: true })
  }
})
