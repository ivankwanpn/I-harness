import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFactBatch } from '@i-harness/core-session'
import { createManagedExecutionDomain } from '@i-harness/core-session/internal/execution'
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { createTaskRegistry } from '../src/task/registry.ts'
import { captureOwnedTaskContext } from '../src/task/owned-context.ts'
import { taskDocumentStorageContract } from '../src/task/storage-contract.ts'
import { SHIPPING_REPORT_POLICY } from '../src/report-policy.ts'
import { createTaskResultRetention } from '../../session-executor/src/lifecycle/task-result-retention.ts'

it.each(['public', 'private'] as const)('reads live Task data during a healthy unrelated %s parent write without granting new work', async kind => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-live-read-'))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let armed = false, writes = 0
  const backend = createJsonlBackend(root, { wrapOwnedBatch: append => async (...args) => {
    if (armed && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'plan/mode')) {
      writes++
      entered.resolve()
      await release.promise
    }
    return append(...args)
  } })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  let tasks: ReturnType<typeof createTaskRegistry> | undefined
  let writing: Promise<unknown> | undefined
  let action: ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']> | undefined
  try {
    await coordinator.create({ sessionId: 'parent' })
    const execution = kind === 'private' ? await acquireManagedExecution(coordinator, 'parent') : undefined
    const publicDocument = execution ? undefined : await coordinator.openManagedDocument('parent')
    const owner = execution?.owner ?? publicDocument!
    const context = execution ? createManagedExecutionDomain(execution.identity, execution.owner, {}) : undefined
    const ownedTask = context ? captureOwnedTaskContext(coordinator, owner, context, 'parent')
      : captureOwnedTaskContext(coordinator, publicDocument!, publicDocument!.view, 'parent')
    tasks = createTaskRegistry({ coordinator, stateId: 'parent', ownedTask, reportPolicy: SHIPPING_REPORT_POLICY,
      results: createTaskResultRetention(undefined, undefined, 'parent') })
    await tasks.ready
    const task = tasks.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'one', description: 'live queued', prompt: 'work', agent: 'general', delivery: 'tool' })
    // LIVE list intentionally includes admitted in-process data before save ACK.
    expect(tasks.list()).toContain(task)
    await tasks.flushPersistence()
    action = owner.beginAction()
    armed = true
    writing = action.captureMetadata!({ type: 'plan/mode', mode: 'on' }).admit()
    await Promise.race([entered.promise, writing.then(() => { throw Error('Original writer missed held phase') })])
    expect(tasks.list()).toEqual([task])
    expect(task.status).toBe('accepted')
    tasks.assertReady()
    expect(writes).toBe(1)
    release.resolve()
    expect(await writing).toMatchObject({ kind: 'committed' })
    action.finish(); action = undefined
    expect(tasks.list()).toEqual([task])
    tasks.retireOwnedLoad()
    expect(() => tasks!.list()).toThrow()
  } finally {
    release.resolve()
    await writing?.catch(() => {})
    action?.finish()
    const failures: unknown[] = []
    for (const close of [() => tasks?.closeOwnedLoad(), () => coordinator.close()]) {
      try { await close() } catch (cause) { failures.push(cause) }
    }
    if (failures.length) throw new AggregateError(failures, 'Original Task read fixture cleanup failed')
  }
})
