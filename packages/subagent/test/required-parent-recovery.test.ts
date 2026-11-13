import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFactBatch, FactRecoveryRequiredError, type BatchKey } from '@i-harness/core-session'
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts'
import { createContext } from '@i-harness/core-plugin'
import { createManagedAgentModelOriginOwner } from '../../core-agent/src/tool-batch/managed-model-origin.ts'
import { createControlledJsonlBackend, createSessionCoordinator, ownedControls } from '../../session-persistence/test/helpers/composed.ts'
import { captureOwnedTaskContext } from '../src/task/owned-context.ts'
import { createTaskRegistry } from '../src/task/registry.ts'
import { bindRequiredTaskSettlement, type RequiredTaskSettlement } from '../src/task/required-settlement.ts'
import { createTaskResultRetention } from '../../session-executor/src/lifecycle/task-result-retention.ts'

// Proposed NEW file packages/subagent/test/required-parent-recovery.test.ts.
// This lower boundary complements the existing real managed/background native
// regression: it exercises the exact parent proof without a second model fixture.
it('recognizes only the original required parent UNKNOWN occurrence after original resolution', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'required-parent-occurrence-'))
  const backend = createControlledJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const execution = await acquireManagedExecution(coordinator, 'parent')
  const document = execution.owner
  const context = createContext()
  const origin = createManagedAgentModelOriginOwner(context, execution)
  const ownedTask = captureOwnedTaskContext(coordinator, document, origin.domain, 'parent')
  const tasks = createTaskRegistry({ coordinator, stateId: 'parent', ownedTask, results: createTaskResultRetention(undefined, undefined, 'parent') })
  await tasks.ready
  const task = tasks.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'one', description: 'one', prompt: 'work', agent: 'general', delivery: 'tool' })
  const otherTask = tasks.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'two', description: 'two', prompt: 'work', agent: 'general', delivery: 'tool' })
  await tasks.flushPersistence()
  const action = document.beginAction()
  let required: RequiredTaskSettlement | undefined
  let other: RequiredTaskSettlement | undefined
  const source = action.registerSettlementSource(async () => { await required?.settle() })
  const otherSource = action.registerSettlementSource(async () => { await other?.settle() })
  required = await bindRequiredTaskSettlement(tasks, task, source, async () => ({ taskId: task.id, outcome: 'cancelled' }))
  other = await bindRequiredTaskSettlement(tasks, otherTask, otherSource, async () => ({ taskId: otherTask.id, outcome: 'cancelled' }))
  await required!.settle()
  await other!.settle()
  // Compatibility view exposure is a supported operation after the private
  // required-parent proof was captured; it must not become a new invariant.
  expect(Object.hasOwn(document, 'view')).toBe(false)
  expect(await coordinator.openManagedDocument('parent')).toBe(document)
  expect(Object.hasOwn(document, 'view')).toBe(true)
  await coordinator.create({ sessionId: 'foreign' })
  const foreignDocument = await coordinator.openManagedDocument('foreign')
  const foreignAction = foreignDocument.beginAction()
  const foreignSource = foreignAction.registerSettlementSource(async () => {})
  const foreignParent = await ownedTask!.operations.requiredParent(foreignDocument, foreignSource)
  let foreignReleased = false

  const control = ownedControls(backend)
  let key: BatchKey | undefined
  let unknown = true
  control.append = async (...args) => {
    const result = await control.originalAppend(...args)
    if (unknown && args[0] === 'parent' && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'plan/mode')) {
      key = args[3].key
      return { kind: 'unknown', key }
    }
    return result
  }
  control.reconcile = async (...args) => unknown && key && args[3].key === key
    ? { kind: 'unknown', key }
    : control.originalReconcile(...args)

  const writerAction = document.beginAction()
  const capture = writerAction.captureMetadata!({ type: 'plan/mode', mode: 'on' })
  let primary: { cause: unknown } | undefined
  let writerResolved = false
  let actionsFinished = false
  try {
    expect((await capture.admit()).kind).toBe('unknown')
    const error = await required!.waitProjectionCurrent().then(() => { throw Error('Original UNKNOWN was not refused') }, error => error)
    expect(error).toBeInstanceOf(FactRecoveryRequiredError)
    const recovered = required!.captureProjectionRecovery!(error)
    expect(recovered).toBeTypeOf('function')
    expect(recovered!()).toBe(false)
    // Same public code, copied error, other original Task, and opaque callback
    // errors cannot borrow this original parent's occurrence.
    expect(required!.captureProjectionRecovery!(new FactRecoveryRequiredError())).toBeUndefined()
    expect(required!.captureProjectionRecovery!(Object.assign(Error('callback'), { code: 'FACT_RECOVERY_REQUIRED' }))).toBeUndefined()
    expect(other!.captureProjectionRecovery!(error)).toBeUndefined()
    expect(ownedTask!.operations.captureRequiredWriterRecovery(foreignParent, error)).toBeUndefined()

    unknown = false
    expect((await capture.reconcile()).kind).toBe('committed')
    writerResolved = true
    expect(recovered!()).toBe(true)
    const ready = Object.getOwnPropertyDescriptor(document, 'assertReady')!
    try {
      Object.defineProperty(document, 'assertReady', { ...ready, value: () => {} })
      expect(recovered!()).toBe(false)
    } finally {
      Object.defineProperty(document, 'assertReady', ready)
    }
    expect(recovered!()).toBe(true)
    await required!.release()
    await other!.release()
    await source.close()
    await otherSource.close()
    await ownedTask!.operations.releaseRequiredParent(foreignParent)
    foreignReleased = true
    await foreignSource.close()
    action.finish()
    writerAction.finish()
    foreignAction.finish()
    actionsFinished = true
    await tasks.closeOwnedLoad()
    await execution.close()
    expect(recovered!()).toBe(true)
  } catch (cause) {
    primary = { cause }
  } finally {
    unknown = false
    const failures: unknown[] = []
    for (const close of [
      async () => { if (key && !writerResolved) await capture.reconcile() },
      async () => { await required?.settle(); await required?.release() },
      async () => { await other?.settle(); await other?.release() },
      () => source.close(),
      () => otherSource.close(),
      async () => { if (!foreignReleased) { await ownedTask!.operations.releaseRequiredParent(foreignParent); foreignReleased = true } },
      () => foreignSource.close(),
      async () => { if (!actionsFinished) { action.finish(); writerAction.finish(); foreignAction.finish() } },
      () => tasks.closeOwnedLoad(),
      () => execution.close(),
      () => context.scope.unmount(),
      () => coordinator.close(),
    ]) {
      try { await close() } catch (cause) { failures.push(cause) }
    }
    if (primary || failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original parent recovery control failed')
  }
}, 15000)
