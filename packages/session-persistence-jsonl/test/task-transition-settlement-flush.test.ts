import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ holdAt: 0, calls: 0, gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined, fail: false }))
vi.mock('../src/backend/bootstrap-header.ts', async original => {
  const real = await original<typeof import('../src/backend/bootstrap-header.ts')>()
  return { ...real, createBootstrapHeaderBackend(...args: Parameters<typeof real.createBootstrapHeaderBackend>) {
    const backend = real.createBootstrapHeaderBackend(...args), settle = backend.settleTrackedHeaderIO
    backend.settleTrackedHeaderIO = async (...input) => {
      fault.calls++
      if (fault.calls === fault.holdAt) { fault.entered?.(); await fault.gate; if (fault.fail) throw false }
      await settle(...input)
    }
    return backend
  } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { pair, guards } from '../../session-persistence/test/child-bootstrap-fixture.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it.each([1, 2])('flush joins original bootstrap header settlement phase %s', async holdAt => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-header-settle-flush-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { payload } = pair(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  fault.holdAt = holdAt; fault.calls = 0; fault.gate = gate.promise; fault.entered = entered.resolve; fault.fail = false
  const bootstrap = coordinator.bootstrapSemanticTarget(payload, guards); void bootstrap.catch(() => {})
  let flushed: Promise<void> | undefined
  try {
    await entered.promise
    let settled = false; flushed = coordinator.flush('target').then(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled, 'flush must join the original active settlement promise').toBe(false)
    gate.resolve(); expect((await bootstrap).kind).toBe('ready'); await flushed
  } finally { gate.resolve(); fault.holdAt = 0; await bootstrap.catch(() => {}); await flushed?.catch(() => {}); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('flush reports a failed original header settlement until the same owner explicitly retries it', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-header-settle-failure-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { payload } = pair(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  fault.holdAt = 2; fault.calls = 0; fault.gate = gate.promise; fault.entered = entered.resolve; fault.fail = true
  const bootstrap = coordinator.bootstrapSemanticTarget(payload, guards); void bootstrap.catch(() => {})
  try {
    await entered.promise; gate.resolve(); expect((await bootstrap).kind).toBe('blocked')
    await expect(coordinator.flush('target')).rejects.toMatchObject({ errors: [{ cause: false }] })
    fault.holdAt = 0; fault.fail = false
    expect(['ready', 'already-ready']).toContain((await coordinator.resumeSemanticTarget(payload.invocation, guards, payload)).kind)
    await coordinator.flush('target')
  } finally { gate.resolve(); fault.holdAt = 0; fault.fail = false; await bootstrap.catch(() => {}); await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
