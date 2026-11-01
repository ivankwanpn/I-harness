import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { coldLegacyFixture } from '../../context-output/test/fixtures/cold-selected-legacy.ts'
import * as documentFactory from '../../session-persistence/src/coordinator/documents.ts'
import { projectBindingWritesFor } from '../../session-persistence/src/coordinator/project-binding-write.ts'
import { observationCleanupFor } from '../../session-persistence/src/coordinator/binding-observation.ts'
import { createProjectScopeBroker } from '../../desktop-gateway/src/project-scope.ts'
import type { Ownership } from '../../session-persistence/src/coordinator/ownership.ts'
const key = 'desktop-session-project-' + createHash('sha256').update('target').digest('hex')
it('connects the actual broker save to original strict publication/readback and exact coordinator association', async () => {
  const registry = vi.spyOn(documentFactory, 'createDocuments'), f = await coldLegacyFixture(true, { kind: 'unassigned' })
  const ownership = registry.mock.calls.at(-1)![1] as Ownership; registry.mockRestore()
  const pin = vi.spyOn(ownership, 'pinOwnershipRetained').mockRejectedValueOnce(Error('original target busy')), broker = createProjectScopeBroker(f.coordinator, f.root)
  try {
    expect(projectBindingWritesFor(f.coordinator)).toBeDefined(); expect(projectBindingWritesFor({ ...f.coordinator })).toBeUndefined()
    await expect(broker.bind('target')).rejects.toThrow('original target busy'); expect(pin).toHaveBeenCalledTimes(1)
    expect(await f.coordinator.getDocument(key)).toBeUndefined(); pin.mockRestore()
    await broker.bind('target'); expect(await f.coordinator.getDocument(key)).toEqual({ version: 1 })
    expect(f.coordinator.ownerOf('target')).toBe(false)
  } finally { pin.mockRestore(); await broker.close(); await f.close() }
})

it.each([false, true])('reuses the genuine bootstrap F0 document lease and retains outer cleanup ownership, debt=%s', async debt => {
  const registry = vi.spyOn(documentFactory, 'createDocuments'), f = await coldLegacyFixture(true, { kind: 'unassigned' })
  const documents = registry.mock.results.at(-1)!.value!, ownership = registry.mock.calls.at(-1)![1] as Ownership; registry.mockRestore()
  const acquire = ownership.acquireDocumentLease!, writer = projectBindingWritesFor(f.coordinator)!
  let acquisitions = 0, fail = debt
  const leases = vi.spyOn(ownership, 'acquireDocumentLease').mockImplementation(async (...args) => {
    const original = await acquire(...args)
    if (args[0] !== key) return original
    acquisitions++
    return { get held() { return original.held }, async release() { if (fail) throw undefined; await original.release() } }
  })
  try {
    const outcome = await f.coordinator.withSessionBindingObservation!({ existingSessionIds: [], target: f.route.request.invocation }, async () => {
      await documents.observations.withSelectedBootstrapMutation(f.route, async () => {
        expect(await writer.write('target', { version: 1 })).toEqual({ version: 1 })
        expect(acquisitions).toBe(1); expect(f.coordinator.ownerOf('target')).toBe(true)
      })
    }).then(() => ({ failed: false as const }), error => ({ failed: true as const, error }))
    expect(outcome.failed).toBe(debt); expect(acquisitions).toBe(1)
    if (outcome.failed) {
      expect(f.coordinator.ownerOf('target')).toBe(true)
      const cleanup = observationCleanupFor(f.coordinator, outcome.error); expect(cleanup).toBeDefined()
      fail = false; await cleanup!.retry()
    }
    expect(f.coordinator.ownerOf('target')).toBe(false); expect(acquisitions).toBe(1)
  } finally { fail = false; leases.mockRestore(); await f.close() }
})
