import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import type { SessionCoordinator } from '../src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
const createSessionCoordinator = (backend: Parameters<typeof composeJsonlTaskTransitionCoordinator>[0], options?: Parameters<typeof composeJsonlTaskTransitionCoordinator>[1]) => composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract)
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createBindingObservations } from '../src/coordinator/binding-observation.ts'
import { createRetainedCleanupOperation, finishRetainedCleanupOperation } from '../src/coordinator/retained-cleanup.ts'
import { requestRetainedReferenceRetirementFor } from '../src/coordinator/retained-binding.ts'

it.each(['explicit', 'read-ticket'] as const)('keeps one held failing native attempt through %s sink joins and outer fallback', async mode => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'cycle-native-debt-'))
  const backend = createJsonlBackend(root), options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const seed = createSessionCoordinator(backend, options), other = createSessionCoordinator(createJsonlBackend(root), options)
  const ownership = createOwnership(backend, options), acquire = ownership.acquireDocumentLease, pin = ownership.pinOwnership
  const held = Promise.withResolvers<void>(), releaseGate = Promise.withResolvers<void>(), sinkEntered = Promise.withResolvers<void>()
  let releases = 0, pins = 0, notifications = 0
  ownership.acquireDocumentLease = async key => { const lock = await acquire(key); return { get held() { return lock.held }, async release() { releases++; if (releases === 1) { held.resolve(); await releaseGate.promise; throw false }; await lock.release() } } }
  ownership.pinOwnership = async id => { const claim = await pin(id); return { assertHeld: claim.assertHeld, retainLive: claim.retainLive, async release() { pins++; await claim.release() } } }
  const owner = createBindingObservations(backend, ownership), operation = createRetainedCleanupOperation()
  // Associate only the original retained-owner lifecycle identity in this
  // resource-level fixture; all lock/pin operations are real native resources.
  const domain = {} as SessionCoordinator; owner.associateRetainedCoordinator(domain)
  const flatten = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error]
  try {
    await seed.create({ sessionId: 's' }); await seed.releaseOwnership('s')
    const ref = await owner.retainExistingSessionBindingObservation({ sessionId: 's' }, async token => {
      notifications++; await Promise.resolve(); sinkEntered.resolve()
      let error: unknown
      try { await ref.release(token) } catch (failure) { error = failure }
      expect(flatten(error)).toContain(false)
      throw 0
    })
    let retiring: Promise<void>
    if (mode === 'explicit') retiring = ref.release(operation)
    else {
      let ticket: Promise<void> | undefined
      await expect(ref.withRead(async () => { ticket = requestRetainedReferenceRetirementFor(domain, ref, 'guard'); expect(() => ref.assertCurrent()).toThrow(); throw undefined })).rejects.toBeUndefined()
      retiring = ticket!
    }
    void retiring.catch(() => {})
    await held.promise; await sinkEntered.promise
    expect(releases).toBe(1); expect(pins).toBe(0)
    await expect(other.adoptOwnership('s')).rejects.toThrow()
    releaseGate.resolve(); let firstFailure: unknown
    try { await retiring } catch (error) { firstFailure = error }
    expect(flatten(firstFailure)).toContain(false)
    if (mode === 'read-ticket') expect(flatten(firstFailure)).toContain(0)
    let fallback: unknown
    try { await owner.closeAdmission(operation)() } catch (error) { fallback = error }
    if (mode === 'explicit') { expect(flatten(fallback)).toContain(false); expect(flatten(fallback)).toContain(0); expect(releases).toBe(1); expect(pins).toBe(0) }
    else { expect(fallback).toBeUndefined(); expect(releases).toBe(2); expect(pins).toBe(1) }
    expect(notifications).toBe(1)
    finishRetainedCleanupOperation(operation)
    await ref.release()
    expect(releases).toBe(2); expect(pins).toBe(1); expect(notifications).toBe(1)
    await other.adoptOwnership('s'); await other.releaseOwnership('s')
  } finally { releaseGate.resolve(); finishRetainedCleanupOperation(operation); await owner.closeAdmission()(); await seed.close(); await other.close(); await rm(root, { recursive: true, force: true }) }
})
