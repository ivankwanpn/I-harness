import { afterEach, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlCommitCoordinator } from '../../session-persistence-jsonl/src/commit-coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'
import { acquireManagedExecution } from '../src/execution-internal.ts'
import { taskDocumentOperationsFor } from '../src/coordinator/task-document-association.ts'
import { createCommitTaskOperations } from '../src/commit/capabilities.ts'
import { taskDocumentStorageContract } from '../src/task-state-internal.ts'

const owners: ReturnType<typeof asSessionCoordinator>[] = []
afterEach(async () => {
  const results = await Promise.allSettled(owners.splice(0).map(owner => owner.close()))
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length) throw new AggregateError(failures, 'Original commit parent fixture cleanup failed')
})

async function fixture() {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'commit-task-parent-'))
  const raw = createJsonlCommitCoordinator(root, { lock: { enabled: true, lockRoot: root } })
  const coordinator = asSessionCoordinator(raw)
  owners.push(coordinator)
  await coordinator.create({ sessionId: 'parent' })
  const execution = await acquireManagedExecution(coordinator, 'parent')
  const operations = taskDocumentOperationsFor(coordinator)!
  return { root, raw, coordinator, execution, operations }
}

it('retains the genuine original commit parent through retirement while refusing fresh work and a closed incarnation', async () => {
  const f = await fixture()
  const parent = f.operations.parent(f.execution.owner)
  f.operations.assertParentSession(parent, 'parent')
  f.operations.assertOriginalParentSession(parent, 'parent')
  f.execution.revokeNewWork()
  expect(() => f.operations.assertParentSession(parent, 'parent')).toThrow()
  expect(() => f.operations.parent(f.execution.owner)).toThrow()
  f.operations.assertOriginalParentSession(parent, 'parent')
  await f.coordinator.closeManagedDocument('parent')
  expect(() => f.operations.assertOriginalParentSession(parent, 'parent')).toThrow()
  const replacement = await acquireManagedExecution(f.coordinator, 'parent')
  expect(replacement.owner).not.toBe(f.execution.owner)
  expect(() => f.operations.assertOriginalParentSession(parent, 'parent')).toThrow()
  const next = f.operations.parent(replacement.owner)
  f.operations.assertOriginalParentSession(next, 'parent')
})

it('rejects copied and foreign commit documents even when a caller supplies a matching session lookup and borrowed real guard', async () => {
  const f = await fixture(), foreign = await fixture()
  const copied = { ...f.execution.owner }
  expect(() => f.operations.parent(copied)).toThrow()
  expect(() => f.operations.parent(foreign.execution.owner)).toThrow()
  const claimed = createCommitTaskOperations(f.raw.capabilities(), {
    putDocument: f.raw.putDocument.bind(f.raw),
    getDocument: f.raw.getDocument.bind(f.raw),
  }, { validator: taskDocumentStorageContract, sessionOfDocument: () => 'parent' })
  const ready = Object.getOwnPropertyDescriptor(f.execution.owner, 'assertReady')!
  const borrowed = { ...f.execution.owner, assertReady: ready.value }
  expect(() => claimed.parent(borrowed)).toThrow()
  expect(() => claimed.parent(foreign.execution.owner)).toThrow()
  f.operations.assertOriginalParentSession(f.operations.parent(f.execution.owner), 'parent')
})

it('rejects changed original commit readiness without invoking an accessor or accepting a replacement method', async () => {
  const f = await fixture()
  const document = f.execution.owner
  const parent = f.operations.parent(document)
  const original = Object.getOwnPropertyDescriptor(document, 'assertReady')!
  let getterReads = 0
  try {
    Object.defineProperty(document, 'assertReady', { configurable: true, enumerable: original.enumerable, get() { getterReads++; return original.value } })
    expect(() => f.operations.assertOriginalParentSession(parent, 'parent')).toThrow()
    expect(() => f.operations.parent(document)).toThrow()
    expect(getterReads).toBe(0)
    Object.defineProperty(document, 'assertReady', { ...original, value: () => {} })
    expect(() => f.operations.assertOriginalParentSession(parent, 'parent')).toThrow()
    expect(() => f.operations.parent(document)).toThrow()
  } finally { Object.defineProperty(document, 'assertReady', original) }
  f.operations.assertParentSession(parent, 'parent')
  f.operations.assertOriginalParentSession(parent, 'parent')
})
