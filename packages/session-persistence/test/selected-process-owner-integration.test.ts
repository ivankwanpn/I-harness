import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator } from '../src/index.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createMutations } from '../src/coordinator/mutations.ts'
import { createLoads } from '../src/coordinator/load.ts'
import { createManagedDocuments } from '../src/coordinator/managed-documents.ts'
import { createBindingObservations } from '../src/coordinator/binding-observation.ts'
import { createProcessReadLatches } from '../src/coordinator/process-read-latches.ts'
import { retainSelectedSourceRead } from '../src/coordinator/managed-document.ts'

it('revokes fixed selected ownership before admission while the same original process owner delivers its suffix', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'selected-process-'))
  const backend = createJsonlBackend(root), options = { lock: { enabled: true } }
  const setup = createSessionCoordinator(backend, options); await setup.create({ sessionId: 'source' }); await setup.close()
  const ownership = createOwnership(backend, options), latches = createProcessReadLatches()
  const mutations = createMutations(backend, ownership, 200, () => {}, undefined, undefined, latches)
  const loads = createLoads(backend, ownership, mutations, latches)
  const registry = createManagedDocuments(backend, ownership, loads.loadOwned, options, () => {}, mutations, latches)
  const bindings = createBindingObservations(backend, ownership)
  const document = await registry.open('source'), selected = await bindings.acquireSelectedBindingRead({ sessionIds: ['source'] })
  const fixed = retainSelectedSourceRead(document, ownership, selected.revoke), processRead = registry.captureProcessRead(document, [])
  try {
    await expect(selected.use(async () => {
      fixed.assertCurrent(); processRead.assertDrained()
      const append = document.metadata.admit({ type: 'plan/mode', mode: 'on' })
      expect(() => fixed.assertCurrent()).toThrow()
      expect(() => selected.assertCurrent()).toThrow()
      expect((await append).kind).toBe('committed')
    })).rejects.toMatchObject({ reason: 'revoked' })
    await selected.release()
    expect(processRead.take()).toMatchObject({ kind: 'suffix', from: 0, to: 1, events: [{ type: 'plan/mode', mode: 'on' }] })
    processRead.assertDrained(); processRead.markVerified()
    const next = await bindings.acquireSelectedBindingRead({ sessionIds: ['source'] })
    const nextFixed = retainSelectedSourceRead(document, ownership, next.revoke)
    try {
      expect((await document.metadata.admit({ type: 'plan/mode', mode: 'off' })).kind).toBe('committed')
      expect(() => nextFixed.assertCurrent()).toThrow(); expect(() => processRead.assertDrained()).toThrow()
    } finally { nextFixed.unsubscribe(); await next.release() }
  } finally {
    fixed.unsubscribe(); processRead.close(); await selected.release(); await bindings.closeAdmission()()
    await registry.close(); await Promise.all(ownership.releaseHeldLocks())
  }
})

it('keeps fixed selected and process reads revoked after original recovery hold release while binding use drains', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'selected-process-hold-'))
  const backend = createJsonlBackend(root), options = { lock: { enabled: true } }
  const setup = createSessionCoordinator(backend, options); await setup.create({ sessionId: 'source' }); await setup.close()
  const originalOwnership = createOwnership(backend, options)
  let originalLock: Awaited<ReturnType<typeof originalOwnership.acquireLease>> | undefined
  const ownership = { ...originalOwnership, async acquireLease(name: string) {
    const lock = await originalOwnership.acquireLease(name); if (name.startsWith('doc:')) originalLock = lock; return lock
  } }
  const latches = createProcessReadLatches(), mutations = createMutations(backend, ownership, 200, () => {}, undefined, undefined, latches)
  const loads = createLoads(backend, ownership, mutations, latches)
  const registry = createManagedDocuments(backend, ownership, loads.loadOwned, options, () => {}, mutations, latches)
  const bindings = createBindingObservations(backend, ownership), document = await registry.open('source')
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const selected = await bindings.acquireSelectedBindingRead({ sessionIds: ['source'] })
  const fixed = retainSelectedSourceRead(document, ownership, selected.revoke), processRead = registry.captureProcessRead(document, [])
  let notifications = 0, reentered = false
  const stop = selected.onRevoke(() => {
    notifications++
    try { retainSelectedSourceRead(document, ownership, () => {}); reentered = true } catch {}
  })
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  const active = selected.use(async () => {
    source.holdRecovery(); source.holdRecovery(); action.finish(); await source.close()
    entered.resolve(); await leave.promise
  }).then(() => undefined, error => error)
  try {
    await entered.promise
    expect(notifications).toBe(1); expect(reentered).toBe(false)
    expect(() => fixed.assertCurrent()).toThrow(); expect(() => selected.assertCurrent()).toThrow()
    expect(() => processRead.assertDrained()).toThrow()
    // Original source close cleared its recovery hold, but binding resources
    // remain owned until this actual selected use leaves.
    expect(originalLock?.held).toBe(true)
    leave.resolve(); expect(await active).toMatchObject({ reason: 'revoked' })
    await selected.release(); expect(originalLock?.held).toBe(false)
    expect(() => fixed.assertCurrent()).toThrow(); expect(() => processRead.assertDrained()).toThrow()
    const fresh = registry.captureProcessRead(document, []); fresh.assertDrained(); fresh.close()
  } finally {
    leave.resolve(); await active; action.finish(); await source.close()
    stop(); fixed.unsubscribe(); processRead.close(); await selected.release(); await bindings.closeAdmission()()
    await registry.close(); await Promise.all(ownership.releaseHeldLocks())
  }
})
