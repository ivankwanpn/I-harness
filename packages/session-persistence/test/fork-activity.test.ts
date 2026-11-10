import { expect, it } from 'vitest'
import type { SessionCoordinator } from '../src/coordinator/types.ts'
import { associateForkHostCleanupOwner, createForkSessionController, hasForkActivity, type ForkHost } from '../src/fork-controller.ts'
import { createForkOperation } from '../src/fork-contract.ts'

it('keeps original preparation cleanup active after its request fails until successful cleanup retry', async () => {
  const coordinator = { inspectBootstrapCapture: async () => {}, bootstrapSemanticTargetWithCapture: async () => {} } as unknown as SessionCoordinator
  const originalFailure = new Error('Original preparation failed')
  let cleanupFails = true, cleanupCalls = 0
  const originalCleanup = { async retry() { cleanupCalls++; if (cleanupFails) throw new Error('Original cleanup still pending') } }
  const host: ForkHost = {
    assertAvailable() {},
    async resolvePreparation() { throw originalFailure },
    async withHandoff() { throw new Error('Unused handoff') },
    async withReadyTarget() { throw new Error('Unused target') },
  }
  associateForkHostCleanupOwner(coordinator, host, error => error === originalFailure ? originalCleanup : undefined)
  const controller = createForkSessionController(coordinator, host)
  try {
    expect(hasForkActivity(coordinator)).toBe(false)
    const preparing = controller.prepare({ version: 1, sourceSessionId: 'source' })
    expect(hasForkActivity(coordinator)).toBe(true)
    await expect(preparing).rejects.toBe(originalFailure)
    expect(hasForkActivity(coordinator)).toBe(true)
    expect(hasForkActivity({} as SessionCoordinator)).toBe(false)
    await expect(controller.close()).rejects.toThrow('Fork cleanup unresolved')
    expect(cleanupCalls).toBe(1)
    expect(hasForkActivity(coordinator)).toBe(true)
    cleanupFails = false
    await controller.close()
    expect(cleanupCalls).toBe(2)
    expect(hasForkActivity(coordinator)).toBe(false)
  } finally { cleanupFails = false; await controller.close() }
})

it('retains execution cleanup activity through retirement retry without counting completed operation records', async () => {
  const coordinator = { inspectBootstrapCapture: async () => ({ kind: 'absent' }), bootstrapSemanticTargetWithCapture: async () => {} } as unknown as SessionCoordinator
  const originalFailure = new Error('Original handoff cleanup failed')
  let cleanupFails = true, cleanupCalls = 0
  const originalCleanup = { async retry() { cleanupCalls++; if (cleanupFails) throw new Error('Original cleanup pending') } }
  const host: ForkHost = {
    assertAvailable() {},
    async resolvePreparation() { return { metadata: {}, project: { kind: 'unmanaged' } } },
    async withHandoff() { throw originalFailure },
    async withReadyTarget() { throw new Error('Unused target') },
  }
  associateForkHostCleanupOwner(coordinator, host, error => error === originalFailure ? originalCleanup : undefined)
  const controller = createForkSessionController(coordinator, host)
  try {
    const prepared = await controller.prepare({ version: 1, sourceSessionId: 'source' })
    if (prepared.kind !== 'prepared') throw new Error('Invalid controlled preparation')
    const operation = createForkOperation(prepared.prepared, { operationId: 'retained', targetSessionId: 'target', createdAt: new Date().toISOString() })
    await expect(controller.execute({ operation, mode: 'begin' })).rejects.toMatchObject({ kind: 'cleanup' })
    expect(hasForkActivity(coordinator)).toBe(true)
    await expect(controller.retire(operation)).rejects.toThrow('Fork cleanup unresolved')
    expect(hasForkActivity(coordinator)).toBe(true)
    cleanupFails = false
    await controller.retire(operation)
    expect(cleanupCalls).toBe(2)
    expect(hasForkActivity(coordinator)).toBe(false)
    await expect(controller.execute({ operation, mode: 'retry' })).resolves.toMatchObject({ kind: 'not-issued', reason: 'cancelled' })
    expect(hasForkActivity(coordinator)).toBe(false)
  } finally { cleanupFails = false; await controller.close() }
})
