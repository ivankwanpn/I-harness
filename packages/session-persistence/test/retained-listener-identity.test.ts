import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '../src/index.ts'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { observeRetainedBindingRetirementFor } from '../src/coordinator/retained-binding.ts'

it.each(['same-owner', 'different-owners'] as const)('joins both shared-function listener registrations on two genuine references (%s)', async population => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'listener-identity-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const finished = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let calls = 0, closed = false
  let closing: Promise<void> | undefined
  try {
    await coordinator.create({ sessionId: 'a' }); await coordinator.releaseOwnership('a')
    if (population === 'different-owners') { await coordinator.create({ sessionId: 'b' }); await coordinator.releaseOwnership('b') }
    const a = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 'a' }, () => {})
    const b = await coordinator.retainExistingSessionBindingObservation!({ sessionId: population === 'same-owner' ? 'a' : 'b' }, () => {})
    expect(a).not.toBe(b)
    const shared = async () => { const index = calls++; await gates[index]!.promise; finished[index]!.resolve() }
    observeRetainedBindingRetirementFor(coordinator, a, shared)
    observeRetainedBindingRetirementFor(coordinator, b, shared)
    // Preserve Set semantics for duplicates on one reference while distinct
    // references retain their independent notification obligations.
    observeRetainedBindingRetirementFor(coordinator, a, shared)
    observeRetainedBindingRetirementFor(coordinator, b, shared)
    closing = coordinator.close().then(() => { closed = true }); void closing.catch(() => {})
    expect(calls).toBe(2)
    gates[0]!.resolve(); await finished[0]!.promise
    await new Promise(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    gates[1]!.resolve(); await closing
    expect(closed).toBe(true)
    await coordinator.close()
    expect(calls).toBe(2)
  } finally { gates.forEach(gate => gate.resolve()); await closing; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('a registration disposer removes its reference obligation without removing the shared handler elsewhere', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'listener-disposer-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  let calls = 0
  try {
    await coordinator.create({ sessionId: 'a' }); await coordinator.releaseOwnership('a')
    const a = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 'a' }, () => {})
    const b = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 'a' }, () => {})
    const shared = async () => { calls++ }
    const removeA = observeRetainedBindingRetirementFor(coordinator, a, shared)
    observeRetainedBindingRetirementFor(coordinator, b, shared)
    removeA(); removeA()
    await coordinator.close()
    expect(calls).toBe(1)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
