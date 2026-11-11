import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createAgentTable, type ChildAgentEntry } from '../src/agent-table.ts'
import { ResidentPreparation, residentOwnerFor } from '../src/followup/resident-lifetime.ts'
import { openFollowupGeneration, captureFollowupGenerationIntent, beginFollowupExecution } from '../src/followup/generation.ts'
import type { SubagentToolDeps } from '../src/tools/types.ts'
import type { ChildInstructionContext } from '../src/child/instruction-context.ts'
import { createContext } from '@i-harness/core-plugin'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createToolRegistry } from '@i-harness/core-tools'
import { createMockClient } from '@i-harness/llm-mock'
import { registerExec } from '@i-harness/exec'
import { createJobRegistry } from '../src/jobs.ts'
import { createRoleRegistry } from '../src/roles.ts'
import { createTaskRegistry } from '../src/task-protocol.ts'
import { createRuntimeContext } from '../../runtime-context/src/index.ts'
import { createRuntimeContextSource } from '../../session-executor/src/lifecycle/action-facts.ts'
import { decodeFactBatch } from '@i-harness/core-session'
import { driveFollowups } from '../src/followup/drive.ts'

function dependencies(table: SubagentToolDeps['table'], parentSession: SubagentToolDeps['parentSession']): SubagentToolDeps {
  const parentCtx = createContext()
  return { table, parentSession, parentCtx, agents: createAgentRegistry(), jobs: createJobRegistry(), roles: createRoleRegistry(),
    tasks: createTaskRegistry(), parentRegistry: createToolRegistry(parentCtx), parentModel: createMockClient([]), exec: registerExec(parentCtx),
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
    generationFactoryFor: (owner, id) => action => createGenerationLifecycle(owner.view, id, action) }
}

async function managedFixture(onRuntimeWrite?: () => void) {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'cap-'))
  const backend = createJsonlBackend(root, onRuntimeWrite ? { wrapOwnedBatch: original => async (...args) => {
    const result = await original(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'runtime/context')) {
      onRuntimeWrite()
      return { kind: 'unknown', key: args[3].key }
    }
    return result
  } } : undefined), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 })
  const document = await coordinator.openManagedDocument('child')
  await document.delivery.record({ type: 'subagent/inbox', messageId: 'saved', message: 'saved', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  const table = createAgentTable(), entry: ChildAgentEntry = { path: 'root/child', sessionId: 'child', session: document.view, factOwner: document, controller: new AbortController(), status: 'waiting', mailbox: [] }
  table.add(entry.path, entry)
  const deps = dependencies(table, document.view)
  const input = document.view.events[0] as Extract<typeof document.view.events[number], { type: 'subagent/inbox' }>
  return { backend, coordinator, document, table, entry, deps, input }
}

it.each([undefined, false].flatMap(failure => [true, false].map(preexisting => ({ failure, preexisting }))))('shares original runtime pin failure $failure with delayed inbox cleanup and external disposal (preexisting=$preexisting)', async ({ failure, preexisting }) => {
  let publications = 0
  const f = await managedFixture(() => { publications++ }), pinEntered = Promise.withResolvers<void>(), releasePin = Promise.withResolvers<void>()
  await f.document.delivery.record({ type: 'subagent/inbox', messageId: 'queued', message: 'different genuine inbox', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  const preparation = new ResidentPreparation(f.deps, f.entry)
  f.entry.dispose = preparation.dispose; preparation.setupExit.resolve()
  const runtime = createRuntimeContext(f.document.view, createRuntimeContextSource(f.document))
  runtime.registerSection('instructions', () => 'original publication')
  let pinCalls = 0, prerequisiteCalls = 0, runtimeCloses = 0, allowPin = false
  let a: Promise<void> | undefined, driving: Promise<void> | undefined, disposing: Promise<void> | undefined
  try {
    preparation.instruction = { requestContext: {} as ChildInstructionContext['requestContext'], retire() {},
      async settleOriginals() { prerequisiteCalls++; await runtime.settleOriginals() },
      async close() { runtimeCloses++; await runtime.close() } }
    const originalIntent = captureFollowupGenerationIntent(f.deps, f.entry, f.input), original = beginFollowupExecution(originalIntent, Promise.resolve())!
    await openFollowupGeneration(f.deps, f.entry, f.input, f.entry.controller, originalIntent)
    original.exitBody(); f.entry.lastInboxSeq = f.input.seq
    await expect(runtime.render(undefined, () => ({ async release() { pinCalls++; pinEntered.resolve(); await releasePin.promise; if (!allowPin) throw failure } }))).rejects.toBeDefined()
    const drive = () => driveFollowups({ table: f.table, agents: f.deps.agents, jobs: f.deps.jobs,
      captureGeneration: (entry, input) => captureFollowupGenerationIntent(f.deps, entry, input),
      openGeneration: (entry, input, controller, intent, current) => openFollowupGeneration(f.deps, entry, input, controller, intent, current),
    }, f.entry, 'child')
    // Exercise both an original finally begun BEFORE any outer scope, and an
    // original prerequisite first admitted by B's predecessor cleanup scope.
    if (preexisting) {
      a = original.close(); void a.catch(() => {})
      await pinEntered.promise; driving = drive(); void driving.catch(() => {})
    } else {
      driving = drive(); void driving.catch(() => {}); await pinEntered.promise; a = original.close()
    }
    const aOutcome = a.then(() => undefined, value => value)
    const driveOutcome = driving.then(() => ({ rejected: false }), value => ({ rejected: true, value }))
    // Let B admit its predecessor scope while A's original pin is held.
    await new Promise<void>(resolve => setImmediate(resolve))
    disposing = residentOwnerFor(f.deps).close()
    const disposeOutcome = disposing.then(() => ({ rejected: false }), value => ({ rejected: true, value }))
    releasePin.resolve()
    await aOutcome
    // Acknowledgment arriving now cannot authorize B's delayed same-attempt call.
    allowPin = true
    const result = await disposeOutcome, b = await driveOutcome
    expect(result.rejected).toBe(true); expect(b.rejected).toBe(true)
    const leaves = (value: unknown): unknown[] => value instanceof AggregateError ? value.errors.flatMap(leaves) : [value]
    expect(leaves('value' in result ? result.value : undefined)).toContain(failure)
    expect(leaves('value' in b ? b.value : undefined)).toContain(failure)
    expect([prerequisiteCalls, pinCalls, runtimeCloses, publications]).toEqual([1, 1, 0, 1])
    expect(f.document.view.events.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(1)
    await residentOwnerFor(f.deps).close()
    expect([prerequisiteCalls, pinCalls, runtimeCloses, publications]).toEqual([2, 2, 1, 1])
    await residentOwnerFor(f.deps).close()
    expect([prerequisiteCalls, pinCalls, runtimeCloses]).toEqual([2, 2, 1])
    console.info('same-attempt-original-pin', JSON.stringify({ failure: String(failure), prerequisiteCalls, pinCalls, runtimeCloses, publications }))
  } finally { allowPin = true; releasePin.resolve(); await Promise.allSettled([a, driving, disposing]); await residentOwnerFor(f.deps).close(); await f.coordinator.close(); await f.deps.parentCtx.scope.unmount() }
})

it.each(['lease', 'document'] as const)('retains managed debt when the original %s settlement capability is missing', async missing => {
  const f = await managedFixture(), finished = f.document.settleFinishedActions
  if (missing === 'document') Object.defineProperty(f.document, 'settleFinishedActions', { value: undefined, configurable: true, writable: true })
  const preparation = new ResidentPreparation(f.deps, f.entry)
  f.document.settleFinishedActions = finished
  const lease = { requestContext: {}, retire() {}, close: async () => {}, ...(missing === 'lease' ? {} : { settleOriginals: async () => {} }) } as ChildInstructionContext
  preparation.instruction = lease; preparation.setupExit.resolve()
  const intent = captureFollowupGenerationIntent(f.deps, f.entry, f.input), execution = beginFollowupExecution(intent, Promise.resolve())!
  const generation = await openFollowupGeneration(f.deps, f.entry, f.input, f.entry.controller, intent)
  execution.exitBody()
  if (missing === 'lease') {
    await expect(generation.close()).rejects.toMatchObject({ code: 'GENERATION_UNSUPPORTED' })
    // A replacement cannot repair an unavailable original capability.
    lease.settleOriginals = async () => {}
    await expect(generation.close()).rejects.toMatchObject({ code: 'GENERATION_UNSUPPORTED' })
    expect(f.document.view.events.filter(event => event.type === 'context/action' && event.op === 'close')).toHaveLength(0)
    expect(residentOwnerFor(f.deps).records.has(execution)).toBe(true)
  } else {
    await expect(execution.settlePredecessors(() => true)).rejects.toMatchObject({ code: 'GENERATION_UNSUPPORTED' })
    await generation.close()
  }
  expect(residentOwnerFor(f.deps).records.has(preparation)).toBe(true)
  await f.coordinator.close()
  await f.deps.parentCtx.scope.unmount()
})

it.each(['removed', 'replaced'] as const)('retains only the admitted original result source through Stop and %s entry until acknowledgment', async mode => {
  const f = await managedFixture(), intent = captureFollowupGenerationIntent(f.deps, f.entry, f.input), execution = beginFollowupExecution(intent, Promise.resolve())!
  expect(execution.resultCurrent()).toBe(false)
  execution.admitSource()
  const store = {} as import('../src/task/result.ts').TaskResultStore
  execution.retainSource(store)
  expect(execution.resultCurrent()).toBe(true)
  f.entry.controller.abort(); execution.retire()
  f.table.remove(f.entry.path)
  if (mode === 'replaced') f.table.add(f.entry.path, { ...f.entry, controller: new AbortController() })
  expect(execution.resultCurrent()).toBe(true)
  const entered = Promise.withResolvers<void>(), acknowledge = Promise.withResolvers<void>()
  execution.retainResult({ projection: () => ({}), settle: async () => { entered.resolve(); await acknowledge.promise; return {} } })
  const settling = execution.settleResult(); await entered.promise
  expect(execution.resultCurrent()).toBe(true)
  acknowledge.resolve(); await settling
  expect(execution.resultCurrent()).toBe(false)
  execution.exitBody(); await execution.close(); await f.coordinator.close(); await f.deps.parentCtx.scope.unmount()
})

it.each([undefined, null, false, 0, ''])('falsey prerequisite %s does not consume original ordinary close invocation', async failure => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'phase-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 })
  const document = await coordinator.openManagedDocument('child')
  await document.delivery.record({ type: 'subagent/inbox', messageId: 'saved', message: 'saved', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
  const table = createAgentTable(), entry: ChildAgentEntry = { path: 'root/child', sessionId: 'child', session: document.view, factOwner: document, controller: new AbortController(), status: 'waiting', mailbox: [] }
  table.add(entry.path, entry)
  let fail = true, closes = 0, recoveries = 0, captures = 0
  const deps = dependencies(table, document.view)
  deps.generationFactoryFor = (owner, id) => action => {
    const lifecycle = createGenerationLifecycle(owner.view, id, action), open = lifecycle.open.bind(lifecycle)
    lifecycle.open = async (...args) => {
      const generation = await open(...args), close = generation.close.bind(generation), recover = generation.recoverClose!.bind(generation)
      generation.close = (...input) => { closes++; return close(...input) }
      generation.recoverClose = () => { recoveries++; return recover() }
      // The acquired public handle need not permit alias replacement.
      const handle = Object.freeze({ close: generation.close, recoverClose: generation.recoverClose, originalCloseInvoked: generation.originalCloseInvoked!.bind(generation) })
      return handle as typeof generation
    }
    return lifecycle
  }
  const begin = document.beginAction.bind(document)
  document.beginAction = (...args) => {
    const action = begin(...args), register = action.registerSettlementSource.bind(action)
    action.registerSettlementSource = (...input) => {
      const source = register(...input), capture = source.generation.capture.bind(source.generation)
      source.generation.capture = event => { if (event.type === 'context/action' && event.op === 'close') captures++; return capture(event) }
      return source
    }
    return action
  }
  const preparation = new ResidentPreparation(deps, entry)
  const lease = { requestContext: {}, retire() {}, close: async () => {}, async settleOriginals() { expect(this).toBe(lease); if (fail) throw failure } } as ChildInstructionContext
  preparation.instruction = lease; preparation.setupExit.resolve()
  const generation = await openFollowupGeneration(deps, entry, document.view.events[0] as Extract<typeof document.view.events[number], { type: 'subagent/inbox' }>, entry.controller)
  try {
    await expect(generation.close()).rejects.toBe(failure)
    expect([closes, recoveries, captures]).toEqual([0, 0, 0])
    fail = false
    lease.settleOriginals = async () => { throw Error('replacement must remain untouched') }
    await generation.close()
    expect([closes, recoveries, captures]).toEqual([1, 0, 1])
  } finally { fail = false; await generation.close(); await coordinator.close(); await deps.parentCtx.scope.unmount() }
})

