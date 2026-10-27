import { fixtureGenerationFor, controlledModel } from '../../subagent/test/generation-fixture.ts'
// TDD: mountAgentTeams lifecycle (M19 Task 10) — REAL wiring test.
//
// Binding corrections (controller, Rulings 17-22): the plan's test cast
// `subagents` as never and skipped typecheck, but the real scheduler derefs
// `subagents.table/jobs/roles/agents`, so this test passes REAL registries
// (createAgentTable/createJobRegistry/createRoleRegistry/createAgentRegistry)
// plus REAL createSession/createToolRegistry. The test-only override seams
// (TeamDeps.spawnChild?/childSessionHoldsPrompt?/IsDurable?/interruptChild?/
// closeChild?/deliver?/memberStatus?) keep the lifecycle real without spawning
// real subagent processes; fix-round-1 tests (Ruling 22) additionally verify
// the REAL deliver bridge (fail-closed flush) and the canonical-teamId
// restore path.
import { describe, expect, it, vi } from "vitest"
import { mountAgentTeams, type TeamDeps } from "../src/index.ts"
import type { TeamMountHandle } from '../src/scheduler.ts'
import { TeamMountFailure } from '../src/scheduler.ts'
import { createCompletionJobs } from '../src/scheduler/completion.ts'
import { createTeamFacts } from '../src/facts.ts'
import { createTeamTransact } from '../src/transact.ts'
import { createMailbox } from '../src/mailbox.ts'
import { foldTeam } from '../src/fold.ts'
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { committedFactSeqs, createSession, decodeFactBatch, isNondurableSession, type BatchKey } from "@i-harness/core-session"
import { ownedTeamFixture } from './owned-fixture.ts'
import { createAgentTable, createJobRegistry, createRoleRegistry, type ChildAgentEntry } from "@i-harness/subagent"
import { snapshotState } from "../../subagent/src/persist.ts"
import { createAgentRegistry, type Agent } from "@i-harness/core-agent"
import { registerExec } from "@i-harness/exec"
/** The seam is required; the teammate role carries no model, so it is never
 * reached — the spawn path that reads a role's model is covered in
 * @i-harness/subagent's child.test.ts. */
const noRoleModel = async () => ({ status: "unconfigured" as const, reason: "unused" })
import type { ModelClient } from "@i-harness/llm-seam"

const TEAM_TOOL_NAMES = [
  "spawn_teammate", "list_members", "send_message", "followup_task", "wait_agent", "interrupt_agent",
  "team_task_create", "team_task_list", "team_task_get", "team_task_update",
]

function model(): ModelClient {
  return controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { yield { type: "end" } as const })
}

// Base fixture: real registries + real bridges (no override seams). Tests that
// spawn/send provide the seams they need — the base only mounts/unmounts, so
// the real bridge closures stay unused there.
function makeDeps(overrides?: Partial<TeamDeps>): TeamDeps {
  const deps: TeamDeps = {
    parentSession: createSession(),
    parentRegistry: createToolRegistry(createContext()),
    subagents: {
      table: createAgentTable(),
      jobs: createJobRegistry(),
      roles: createRoleRegistry(),
      agents: createAgentRegistry(),
      exec: registerExec(createContext()),
      resolveModel: noRoleModel,
    },
    parentModel: model(),
  }
  return overrides ? { ...deps, ...overrides } : deps
}

describe("mountAgentTeams lifecycle", () => {
  it.each(['child-first', 'ack-first'] as const)('joins original accepted child acquisition before freezing cleanup membership (%s)', async order => {
    const f = await ownedTeamFixture([
      { type: 'team/member', version: 1, teamId: 'acquisition-team', member: { id: 'target-id', name: 'target', description: 'd', provider: 'spawn', context: 'fresh', phase: 'provisioning' } },
      { type: 'team/member', version: 1, teamId: 'acquisition-team', member: { id: 'target-id', name: 'target', description: 'd', provider: 'spawn', context: 'fresh', phase: 'active', sessionId: 'target' } },
    ])
    await f.coordinator.create({ sessionId: 'target', parentSession: 'parent' })
    const target = await f.coordinator.openManagedDocument('target')
    const ctx = createContext(), tools = createToolRegistry(ctx), deps = makeDeps({ parentSession: f.document.view, factOwner: f.document, parentRegistry: tools })
    deps.subagents.generationFactoryFor = fixtureGenerationFor
    deps.subagents.childSessions = { coordinator: f.coordinator, parentSessionId: 'parent' }
    let targetDisposes = 0
    deps.subagents.table.add('lead/target', { path: 'lead/target', status: 'waiting', session: target.view, factOwner: target,
      sessionId: 'target', controller: new AbortController(), mailbox: [], async dispose() { targetDisposes++; await target.close() },
    })
    const childCreated = Promise.withResolvers<void>(), releaseChild = Promise.withResolvers<void>()
    const ackEntered = Promise.withResolvers<void>(), releaseAck = Promise.withResolvers<void>()
    const published = Promise.withResolvers<ChildAgentEntry>(), debtReady = Promise.withResolvers<void>()
    const create = f.coordinator.create.bind(f.coordinator), append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
    let childCreates = 0, allowChildAck = false, childKey: BatchKey | undefined, childWrites = 0, disposeCalls = 0
    let lateEntry: ChildAgentEntry | undefined, lateAgent: Agent | undefined
    const childKeys: BatchKey[] = [], receipts: unknown[] = []
    let debtWork: Promise<void> | undefined
    f.coordinator.create = async (...args) => {
      const result = await create(...args)
      if (args[0]?.sessionId?.startsWith('child-')) { childCreates++; childCreated.resolve(); await releaseChild.promise }
      return result
    }
    f.backend.appendOwnedBatch = async (...args) => {
      const events = decodeFactBatch(args[3].bytes).events, result = await append(...args)
      if (events.some(event => event.type === 'team/message/delivered')) { ackEntered.resolve(); await releaseAck.promise }
      if (events.some(event => event.type === 'subagent/inbox' && event.messageId === 'late-child-cleanup-debt')) {
        childWrites++; childKey = args[3].key
        const reported = { kind: 'unknown' as const, key: childKey }
        receipts.push({ actual: result, reported }); return reported
      }
      return result
    }
    f.backend.reconcileOwnedBatch = async (...args) => {
      if (childKey && args[3].key.batchId === childKey.batchId) {
        childKeys.push(args[3].key)
        if (!allowChildAck) return { kind: 'unknown', key: args[3].key }
      }
      return reconcile(...args)
    }
    const off = deps.subagents.table.subscribe(change => {
      if (change.path !== 'lead/late' || change.kind !== 'add') return
      const entry = change.entry
      lateEntry = entry; lateAgent = deps.subagents.agents.get(entry.sessionId!)
      const dispose = entry.dispose!
      entry.dispose = async () => { disposeCalls++; await debtReady.promise; await dispose() }
      published.resolve(entry)
    })
    const installChildDebt = (entry: ChildAgentEntry) => {
      // Give the actual published child's document a real required audit whose
      // committed backend return is hidden. Its own close must reconcile it.
      const action = entry.factOwner!.beginAction()
      let fact: ReturnType<ReturnType<typeof action.registerSettlementSource>['delivery']['capture']>
      const source = action.registerSettlementSource(async () => { committedFactSeqs(await fact.reconcile()) })
      action.finish()
      fact = source.delivery.capture({ type: 'subagent/inbox', messageId: 'late-child-cleanup-debt', message: 'original child cleanup debt',
        provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' },
      })
      debtWork = fact.admit().then(outcome => { expect(outcome.kind).toBe('unknown'); debtReady.resolve() }, debtReady.reject)
    }
    const handle = await mountAgentTeams(ctx, tools, deps)
    const spawning = tools.get('spawn_teammate')!.execute({ name: 'late', description: 'd', prompt: 'quiet local fixture' }, {}).then(value => ({ value }), error => ({ error }))
    await childCreated.promise
    expect(deps.subagents.table.get('lead/late')).toBeUndefined()
    expect(f.document.view.events.some(event => event.type === 'team/member' && event.member.name === 'late' && event.member.phase === 'provisioning')).toBe(true)
    const sending = tools.get('send_message')!.execute({ target: 'target', message: 'hold original Team acknowledgement' }, {})
    await ackEntered.promise
    const waiting = tools.get('wait_agent')!.execute({ timeout_ms: 30_000 }, {})
    let cleanupSettled = false
    const closing = handle.unmount().then(() => { cleanupSettled = true; return { errors: [] as unknown[] } }, error => { cleanupSettled = true; return error as AggregateError })
    try {
      expect(await waiting).toMatchObject({ timedOut: false })
      expect(() => tools.get('spawn_teammate')!.execute({ name: 'too-late', description: 'd', prompt: 'blocked' }, {})).toThrow(/closed/)
      if (order === 'ack-first') {
        releaseAck.resolve(); await sending
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(cleanupSettled).toBe(false)
        expect(deps.subagents.table.get('lead/late')).toBeUndefined()
      }
      releaseChild.resolve()
      const exactEntry = await published.promise
      // Finish the actual local initial generation before introducing the
      // independent cleanup debt, so no unrelated generation source is refused.
      await exactEntry.followupChain
      installChildDebt(exactEntry)
      await debtReady.promise
      expect(exactEntry).toBe(lateEntry)
      expect(deps.subagents.table.get('lead/late')).toBe(exactEntry)
      expect(cleanupSettled).toBe(false)
      releaseAck.resolve(); await sending
      expect(await spawning).toMatchObject({ value: { member: { name: 'late' } } })
      await debtWork
      const failure = await closing
      expect(failure.errors.length).toBeGreaterThan(0)
      expect(deps.subagents.table.get('lead/late')).toBe(exactEntry)
      expect(deps.subagents.agents.get(exactEntry.sessionId!)).toBe(lateAgent)
      expect(disposeCalls).toBe(1)
      await expect(mountAgentTeams(ctx, tools, makeDeps())).rejects.toThrow(/only one team/)
      allowChildAck = true; await handle.unmount()
      expect(disposeCalls).toBe(2)
      expect(deps.subagents.table.get('lead/late')).toBeUndefined()
      expect(deps.subagents.agents.get(exactEntry.sessionId!)).toBeUndefined()
      expect(deps.subagents.jobs.read(exactEntry.jobId!).status).not.toBe('running')
      expect(childCreates).toBe(1); expect(childWrites).toBe(1)
      expect(targetDisposes).toBe(1)
      for (const key of childKeys) expect(key).toEqual(childKey)
      expect(exactEntry.session.events.filter(event => event.type === 'subagent/inbox' && event.messageId === 'late-child-cleanup-debt')).toHaveLength(1)
      console.info('accepted-acquisition-cleanup-evidence', JSON.stringify({ order, root: f.root, childSessionId: exactEntry.sessionId, childCreates, childWrites, disposeCalls, targetDisposes, childKey, childKeys, receipts }))
    } finally {
      releaseChild.resolve(); releaseAck.resolve(); allowChildAck = true; debtReady.resolve()
      await spawning; await sending; await debtWork; await closing
      off()
      await handle.unmount()
      // Baseline's omitted entry still needs its exact original disposal in
      // fixture teardown; this is never counted as successful Team cleanup.
      if (lateEntry && deps.subagents.table.get('lead/late') === lateEntry) {
        await lateEntry.dispose!(); deps.subagents.table.remove('lead/late')
        if (lateEntry.sessionId && deps.subagents.agents.get(lateEntry.sessionId) === lateAgent) deps.subagents.agents.remove(lateEntry.sessionId)
      }
      await f.coordinator.close()
    }
  })

  for (const error of [undefined, null]) it(`joins concurrent unmounts through original failed run ${String(error)} without source-producer self-wait`, async () => {
    const f = await ownedTeamFixture(), ctx = createContext(), tools = createToolRegistry(ctx)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const begin = f.document.beginAction.bind(f.document)
    let source: ReturnType<ReturnType<typeof begin>['registerSettlementSource']> | undefined, attempts = 0
    f.document.beginAction = (...args) => {
      const action = begin(...args), register = action.registerSettlementSource.bind(action)
      action.registerSettlementSource = producer => { source = register(producer); return source }
      return action
    }
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ parentSession: f.document.view, factOwner: f.document,
      spawnChild: async () => { attempts++; entered.resolve(); await release.promise; throw error },
    }))
    const spawning = tools.get('spawn_teammate')!.execute({ name: 'fails', description: 'd', prompt: 'original' }, {})
    const original = spawning.catch(value => ({ occurred: true, error: value }))
    await entered.promise
    let closed = false
    const first = handle.unmount(), second = handle.unmount()
    void first.then(() => { closed = true }, () => { closed = true })
    try {
      expect(second).toBe(first)
      // The actual source producer may run while accepted outer work is held.
      // It drains its original lane, never recursively joins this tool run.
      await source!.close()
      expect(closed).toBe(false)
      release.resolve()
      expect(await original).toEqual({ occurred: true, error })
      await Promise.all([first, second])
      await expect(spawning).rejects.toBe(error)
      await expect(handle.unmount()).resolves.toBeUndefined()
      expect(attempts).toBe(1)
      expect(f.document.view.events.filter(event => event.type === 'team/member').map(event => event.member.phase)).toEqual(['provisioning', 'failed'])
      expect(f.document.view.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(0)
    } finally { release.resolve(); await original; await first; await f.coordinator.close() }
  })

  for (const error of [undefined, null]) it(`completion cleanup retains and reports original ${String(error)} once without replaying delivery`, async () => {
    const f = await ownedTeamFixture(), deps = makeDeps()
    const state = foldTeam([]).state
    state.members.set('helper', { id: 'child', name: 'helper', description: '', provider: 'spawn', context: 'fresh', phase: 'active' })
    const lead = createTeamFacts(f.document, () => tx.drain(), () => {})
    const tx = createTeamTransact(lead, state)
    let calls = 0
    const mailbox = createMailbox({ teamId: 'team', state, transact: tx, memberStatus: () => 'idle',
      deliver: async () => { calls++; return { kind: 'consumed', via: 'target', sendFailure: { occurred: true, error } } },
    })
    const { id } = deps.subagents.jobs.registerJob('root', 'subagent', 'helper')
    const entry = { path: 'lead/helper', jobId: id, status: 'waiting' as const, session: createSession(), controller: new AbortController(), mailbox: [] }
    deps.subagents.table.add(entry.path, entry)
    const completion = createCompletionJobs(deps.subagents, state, { maxMembers: 8, maxTasks: 256, maxPendingMessagesPerMember: 64, maxMessageBytes: 65_536, startupTimeoutMs: 10_000, waitMinMs: 10_000, waitMaxMs: 3_600_000, waitDefaultMs: 30_000 }, () => false, () => mailbox, () => ({ notify() {} }))
    try {
      completion.teamJobs.updateJob(id, { status: 'completed', output: 'report' })
      await vi.waitFor(() => expect(f.document.view.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(1))
      await new Promise<void>(resolve => setImmediate(resolve))
      // Baseline deleted settled jobs and silently discarded this exact error.
      expect(completion.completionJobs.size).toBe(1)
      completion.sealCompletions()
      await expect(completion.joinCompletions()).rejects.toMatchObject({ errors: [error] })
      await lead.close()
      await expect(completion.joinCompletions()).resolves.toBeUndefined()
      const second = deps.subagents.jobs.registerJob('root', 'subagent', 'second')
      deps.subagents.table.update(entry.path, entry, { jobId: second.id })
      completion.teamJobs.updateJob(second.id, { status: 'completed', output: 'late' })
      expect(completion.completionJobs.size).toBe(0)
      expect(calls).toBe(1)
      expect(f.document.view.events.map(event => event.type)).toEqual(['team/message/queued', 'team/message/delivered'])
    } finally { await f.coordinator.close() }
  })

  it('cleanup ownership retains the shell before source construction and cleans a throwing retain callback', async () => {
    const ctx = createContext(), tools = createToolRegistry(ctx), deps = makeDeps()
    const failure = new Error('retain failed')
    let retained: TeamMountHandle | undefined
    const result = await mountAgentTeams(ctx, tools, { ...deps, retainMount(handle) { retained = handle; throw failure } }).then(async handle => { await handle.unmount(); return handle }, error => error)
    expect(result).toBe(failure)
    expect(retained).toBeDefined()
    await retained!.unmount()
    const next = await mountAgentTeams(ctx, tools, deps)
    await next.unmount()
  })

  it('cleanup ownership fences construction when the retained shell retires during recovery', async () => {
    const f = await ownedTeamFixture([{ type: 'team/message/queued', version: 1, teamId: 'retiring-construction', message: {
      id: 'held-recovery', senderId: 'child', senderName: 'helper', targetId: 'retiring-construction', delivery: 'quiet', content: 'held',
    } }])
    const ctx = createContext(), tools = createToolRegistry(ctx), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<boolean>()
    let retained: TeamMountHandle | undefined
    const mounting = mountAgentTeams(ctx, tools, makeDeps({ parentSession: f.document.view, factOwner: f.document,
      retainMount(handle) { retained = handle }, deliver: async () => { entered.resolve(); return release.promise },
    })).then(handle => ({ handle }), error => ({ error }))
    await entered.promise
    const closing = retained!.unmount()
    try {
      release.resolve(true)
      const result = await mounting
      await closing
      expect(result).toMatchObject({ error: { code: 'FACT_CLOSED' } })
      expect(tools.get('send_message')).toBeUndefined()
      const next = await mountAgentTeams(ctx, tools, makeDeps()); await next.unmount()
    } finally { release.resolve(false); await mounting; await retained!.unmount(); await f.coordinator.close() }
  })

  it('cleanup ownership retains the exact registered source when construction fails before facts return', async () => {
    const f = await ownedTeamFixture(), ctx = createContext(), tools = createToolRegistry(ctx)
    const begin = f.document.beginAction.bind(f.document)
    const construction = new Error('finish after source registration failed'), cleanup = new Error('source close held')
    let blocked = true, source: object | undefined, retained: TeamMountHandle | undefined, begins = 0, closes = 0
    f.document.beginAction = (...args) => {
      begins++
      const action = begin(...args), register = action.registerSettlementSource.bind(action), finish = action.finish.bind(action)
      let first = true
      action.registerSettlementSource = producer => {
        const actual = register(producer), close = actual.close.bind(actual)
        source = actual
        actual.close = async () => { closes++; if (blocked) throw cleanup; await close() }
        return actual
      }
      action.finish = () => { if (first) { first = false; throw construction }; finish() }
      return action
    }
    try {
      const failure = await mountAgentTeams(ctx, tools, makeDeps({ parentSession: f.document.view, factOwner: f.document, retainMount(handle) { retained = handle } })).catch(error => error)
      expect(failure).toBeInstanceOf(TeamMountFailure)
      expect(failure.cause).toBe(construction); expect(failure.cleanup).toBe(retained)
      expect(source).toBeDefined(); expect([begins, closes]).toEqual([1, 1])
      blocked = false; await retained!.unmount()
      expect([begins, closes]).toEqual([1, 2])
    } finally { blocked = false; await retained?.unmount(); await f.coordinator.close() }
  })

  it('cleanup ownership preserves falsey registration and unfinished action cleanup failures without inventing a source', async () => {
    const f = await ownedTeamFixture(), ctx = createContext(), tools = createToolRegistry(ctx)
    const begin = f.document.beginAction.bind(f.document)
    let blocked = true, registrations = 0, finishes = 0, retained: TeamMountHandle | undefined
    f.document.beginAction = (...args) => {
      const action = begin(...args), finish = action.finish.bind(action)
      action.registerSettlementSource = () => { registrations++; throw undefined }
      action.finish = () => { finishes++; if (blocked) throw null; finish() }
      return action
    }
    try {
      const failure = await mountAgentTeams(ctx, tools, makeDeps({ parentSession: f.document.view, factOwner: f.document, retainMount(handle) { retained = handle } })).catch(error => error)
      expect(failure).toBeInstanceOf(TeamMountFailure)
      expect(failure.cause).toBeUndefined()
      expect(failure.errors[1].errors).toEqual([null])
      expect([registrations, finishes]).toEqual([1, 1])
      blocked = false; await retained!.unmount()
      expect([registrations, finishes]).toEqual([1, 2])
    } finally { blocked = false; await retained?.unmount(); await f.coordinator.close() }
  })

  it('cleanup ownership permits actual empty producer drain before the transaction is initialized', async () => {
    const f = await ownedTeamFixture(), ctx = createContext(), tools = createToolRegistry(ctx)
    const begin = f.document.beginAction.bind(f.document)
    let producerDrains = 0
    f.document.beginAction = (...args) => {
      const action = begin(...args), register = action.registerSettlementSource.bind(action)
      action.registerSettlementSource = producer => {
        const source = register(producer)
        // Native producer calls are legal before the transaction facade returns.
        // An empty actual facts owner needs no uninitialized transaction read.
        producerDrains++; void producer()
        return source
      }
      return action
    }
    let handle: TeamMountHandle | undefined
    try {
      handle = await mountAgentTeams(ctx, tools, makeDeps({ parentSession: f.document.view, factOwner: f.document }))
      expect(producerDrains).toBe(1)
    } finally { await handle?.unmount(); await f.coordinator.close() }
  })

  it('cleanup ownership retries the exact failed child before releasing the reservation', async () => {
    const ctx = createContext(), tools = createToolRegistry(ctx), deps = makeDeps()
    let blocked = true, attempts = 0
    const failure = new Error('child cleanup held')
    const entry = { path: 'lead/helper', status: 'waiting' as const, session: createSession(), controller: new AbortController(), mailbox: [],
      async dispose() { attempts++; if (blocked) throw failure },
    }
    deps.subagents.table.add(entry.path, entry)
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      await expect(handle.unmount()).rejects.toMatchObject({ errors: expect.arrayContaining([failure]) })
      expect(deps.subagents.table.get(entry.path)).toBe(entry)
      await expect(mountAgentTeams(ctx, tools, deps)).rejects.toThrow(/only one team|already mounted/)
      blocked = false
      await handle.unmount()
      expect(attempts).toBe(2)
      expect(deps.subagents.table.get(entry.path)).toBeUndefined()
      const next = await mountAgentTeams(ctx, tools, deps)
      await next.unmount()
    } finally { blocked = false; await handle.unmount() }
  })

  it('cleanup ownership retains actual child audit debt until its original backend acknowledgement', async () => {
    const parent = await ownedTeamFixture([
      { type: 'team/member', version: 1, teamId: 'child-debt-team', member: { id: 'child-id', name: 'helper', description: 'd', provider: 'spawn', context: 'fresh', phase: 'provisioning' } },
      { type: 'team/member', version: 1, teamId: 'child-debt-team', member: { id: 'child-id', name: 'helper', description: 'd', provider: 'spawn', context: 'fresh', phase: 'active', sessionId: 'child' } },
    ])
    const child = await ownedTeamFixture([], 'child'), ctx = createContext(), tools = createToolRegistry(ctx)
    const deps = makeDeps({ parentSession: parent.document.view, factOwner: parent.document })
    const append = child.backend.appendOwnedBatch!, reconcile = child.backend.reconcileOwnedBatch!
    let allow = false, writes = 0
    const keys: string[] = []
    child.backend.appendOwnedBatch = async (...args) => { writes++; await append(...args); return { kind: 'unknown', key: args[3].key } }
    child.backend.reconcileOwnedBatch = async (...args) => { keys.push(args[3].key.batchId); return allow ? reconcile(...args) : { kind: 'unknown', key: args[3].key } }
    const entry = { path: 'lead/helper', status: 'waiting' as const, session: child.document.view, factOwner: child.document, sessionId: 'child', controller: new AbortController(), mailbox: [], dispose: () => child.document.close() }
    deps.subagents.table.add(entry.path, entry)
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      await expect(tools.get('send_message')!.execute({ target: 'helper', message: 'audit held' }, {})).resolves.toMatchObject({ status: 'queued' })
      await expect(handle.unmount()).rejects.toThrow(/cleanup incomplete/)
      expect(deps.subagents.table.get(entry.path)).toBe(entry)
      await expect(mountAgentTeams(ctx, tools, deps)).rejects.toThrow(/only one team|already mounted/)
      allow = true; await handle.unmount()
      expect(deps.subagents.table.get(entry.path)).toBeUndefined()
      expect(writes).toBe(1); expect(new Set(keys).size).toBe(1)
      expect(child.document.view.events.filter(event => event.type === 'subagent/inbox')).toHaveLength(1)
      expect(parent.document.view.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(0)
      console.info('child-cleanup-evidence', JSON.stringify({ parentRoot: parent.root, childRoot: child.root, writes, keys }))
    } finally { allow = true; await handle.unmount(); await child.coordinator.close(); await parent.coordinator.close() }
  })

  it('cleanup ownership retries a failed job cancellation without repeating acknowledged child disposal', async () => {
    const child = await ownedTeamFixture([], 'child'), ctx = createContext(), tools = createToolRegistry(ctx), deps = makeDeps()
    let blocked = true, removeBlocked = true, disposed = 0
    const failure = new Error('cancel held')
    const job = deps.subagents.jobs.registerJob('root', 'subagent', 'helper', undefined, undefined, () => { if (blocked) throw failure })
    const entry = { path: 'lead/helper', sessionId: 'child', jobId: job.id, status: 'waiting' as const, session: child.document.view, controller: new AbortController(), mailbox: [],
      async dispose() { disposed++; await child.document.close() },
    }
    deps.subagents.table.add(entry.path, entry)
    const agent: Agent = { run: vi.fn(), followup: vi.fn() }
    deps.subagents.agents.register('child', agent)
    const remove = deps.subagents.agents.remove.bind(deps.subagents.agents)
    deps.subagents.agents.remove = id => { if (removeBlocked) throw null; remove(id) }
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      await expect(handle.unmount()).rejects.toMatchObject({ errors: [failure] })
      expect(deps.subagents.table.get(entry.path)).toBe(entry)
      expect(disposed).toBe(1)
      blocked = false; await expect(handle.unmount()).rejects.toMatchObject({ errors: [null] })
      expect(deps.subagents.agents.get('child')).toBe(agent)
      removeBlocked = false; await handle.unmount()
      expect(disposed).toBe(1)
      expect(deps.subagents.table.get(entry.path)).toBeUndefined()
      expect(deps.subagents.agents.get('child')).toBeUndefined()
    } finally { blocked = false; removeBlocked = false; await handle.unmount(); await child.coordinator.close() }
  })

  it('cleanup ownership retains exact tool and role failures and continues independent phases', async () => {
    const ctx = createContext(), tools = createToolRegistry(ctx), deps = makeDeps()
    const handle = await mountAgentTeams(ctx, tools, deps)
    const originalTool = tools.get('send_message'), originalRole = deps.subagents.roles.get('teammate')
    const unregister = tools.unregister.bind(tools), remove = deps.subagents.roles.remove.bind(deps.subagents.roles)
    let heldTool = true, heldRole = true
    tools.unregister = name => { if (name === 'send_message' && heldTool) throw undefined; return unregister(name) }
    deps.subagents.roles.remove = name => { if (name === 'teammate' && heldRole) throw null; return remove(name) }
    try {
      const failure = await handle.unmount().catch(error => error)
      expect(failure.errors[0].errors).toEqual([undefined]); expect(failure.errors[1]).toBeNull()
      expect(tools.get('send_message')).toBe(originalTool)
      expect(tools.get('spawn_teammate')).toBeUndefined()
      expect(deps.subagents.roles.get('teammate')).toBe(originalRole)
      heldTool = false
      await expect(handle.unmount()).rejects.toMatchObject({ errors: [null] })
      expect(tools.get('send_message')).toBeUndefined()
      await expect(mountAgentTeams(ctx, tools, deps)).rejects.toThrow(/only one team|already mounted/)
      heldRole = false; await handle.unmount()
      expect(deps.subagents.roles.get('teammate')).toBeUndefined()
    } finally { heldTool = false; heldRole = false; await handle.unmount() }
  })

  it('cleanup ownership retains partial tool replacement and retries original restoration', async () => {
    const ctx = createContext(), tools = createToolRegistry(ctx), deps = makeDeps()
    const original = { name: 'send_message', description: 'original', inputSchema: { type: 'object' }, execute: async () => 'original' }
    tools.register(original)
    const register = tools.register.bind(tools)
    const construction = new Error('tool publication failed'), cleanup = new Error('tool restoration held')
    let blocked = true, retained: TeamMountHandle | undefined
    tools.register = tool => {
      if (tool.name === 'followup_task') throw construction
      if (tool === original && blocked) throw cleanup
      return register(tool)
    }
    try {
      const result = await mountAgentTeams(ctx, tools, { ...deps, retainMount(handle) { retained = handle } }).catch(error => error)
      expect(result).toMatchObject({ cause: construction, cleanup: retained })
      expect(retained).toBeDefined()
      await expect(mountAgentTeams(ctx, tools, deps)).rejects.toThrow(/only one team|already mounted/)
      blocked = false; tools.register = register
      await retained!.unmount()
      expect(tools.get('send_message')).toBe(original)
      expect(tools.get('spawn_teammate')).toBeUndefined()
      const next = await mountAgentTeams(ctx, tools, deps); await next.unmount()
    } finally { blocked = false; tools.register = register; await retained?.unmount() }
  })

  it('cleanup ownership releases waiters before joining an accepted held driver and fences new work', async () => {
    const ctx = createContext(), tools = createToolRegistry(ctx)
    const owned = await ownedTeamFixture([
      { type: 'team/member', version: 1, teamId: 'held-team', member: { id: 'child', name: 'helper', description: 'd', provider: 'spawn', context: 'fresh', phase: 'provisioning' } },
      { type: 'team/member', version: 1, teamId: 'held-team', member: { id: 'child', name: 'helper', description: 'd', provider: 'spawn', context: 'fresh', phase: 'active', sessionId: 'child' } },
    ])
    const deps = makeDeps({ parentSession: owned.document.view, factOwner: owned.document })
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<boolean>()
    deps.deliver = async () => { entered.resolve(); return release.promise }
    const handle = await mountAgentTeams(ctx, tools, deps)
    const send = tools.get('send_message')!, wait = tools.get('wait_agent')!
    const waiting = wait.execute({ timeout_ms: 30_000 }, {})
    const sending = send.execute({ target: 'helper', message: 'held' }, {})
    await entered.promise
    let closed = false
    const closing = handle.unmount().then(() => { closed = true })
    try {
      expect(await waiting).toMatchObject({ timedOut: false })
      expect(() => send.execute({ target: 'helper', message: 'late' }, {})).toThrow(/closed/)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      expect(owned.document.view.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(0)
      release.resolve(true); await sending; await closing
      expect(owned.document.view.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(1)
    } finally { release.resolve(false); await closing; await owned.coordinator.close() }
  })

  it("recovery reads live parent admission after the target flush and acknowledges before tool publication", async () => {
    const ctx = createContext(), tools = createToolRegistry(ctx)
    const f = await ownedTeamFixture([{ type: "team/message/queued", version: 1, teamId: "lead-order", message: {
      id: "msg-order", senderId: "child-helper", senderName: "helper", targetId: "lead-order", delivery: "quiet", content: "recovered",
    } }])
    const parentSession = f.document.view
    const flushed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), order: string[] = []
    const actual = f.backend.appendOwnedBatch!
    f.backend.appendOwnedBatch = async (...args) => {
      const events = decodeFactBatch(args[3].bytes).events
      const result = await actual(...args)
      expect(tools.get('send_message')).toBeUndefined()
      if (events.some(event => event.type === 'subagent/inbox')) {
        order.push('target-receipt')
        expect(parentSession.events.some(event => event.type === 'subagent/inbox')).toBe(false)
        flushed.resolve(); await release.promise
      } else if (events.some(event => event.type === 'team/message/delivered')) order.push('ack-receipt')
      return result
    }
    const oldAdmission = { admit: vi.fn(async () => {}), wake: vi.fn() }
    const currentAdmission = {
      async admit(input: { text: string }) {
        expect(this).toBe(currentAdmission)
        expect(input.text).toBe("Team message <msg-order> from <helper>:\nrecovered")
        expect(parentSession.events.some(event => event.type === "team/message/delivered")).toBe(false)
        order.push("admit")
      },
      wake() { expect(this).toBe(currentAdmission); order.push("wake") },
    }
    const deps = makeDeps({ parentSession, factOwner: f.document, parentNotify: oldAdmission })
    deps.subagents.childSessions = { coordinator: f.coordinator, parentSessionId: "parent" }
    const mounting = mountAgentTeams(ctx, tools, deps)
    await flushed.promise
    deps.parentNotify = currentAdmission
    release.resolve()
    const handle = await mounting
    try {
      expect(order).toEqual(["target-receipt", "admit", "wake", "ack-receipt"])
      expect(oldAdmission.admit).not.toHaveBeenCalled()
      expect(tools.get("send_message")).toBeDefined()
      await handle.drainLeadMessages!()
      expect(order).toHaveLength(4)
    } finally { release.resolve(); await handle.unmount(); await f.coordinator.close() }
  })

  it("unmount releases waiters while child disposal is blocked and restores tools after disposal settles", async () => {
    const ctx = createContext(), tools = createToolRegistry(ctx), deps = makeDeps()
    const release = Promise.withResolvers<void>(), disposing = Promise.withResolvers<void>(), order: string[] = []
    const previous = { name: "wait_agent", description: "original", inputSchema: { type: "object" }, execute: async () => "original" }
    tools.register(previous)
    if(!isNondurableSession(deps.parentSession))throw new Error('Standalone fixture expected')
    deps.parentSession.events.push(
      { type: "team/member", version: 1, teamId: "lead-unmount-order", member: { id: "helper", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 1, teamId: "lead-unmount-order", member: { id: "helper", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active", sessionId: "child" } },
    )
    const controller = new AbortController()
    deps.subagents.table.add("lead/helper", { path: "lead/helper", status: "running", session: createSession(), controller, mailbox: [],
      async dispose() { order.push("dispose"); disposing.resolve(); await release.promise; order.push("disposed") },
    })
    const handle = await mountAgentTeams(ctx, tools, deps)
    const teamWait = tools.get("wait_agent")!
    const waiting = teamWait.execute({ timeout_ms: 30_000 }, {}).then(result => { order.push("wait-released"); return result })
    const closing = handle.unmount()
    try {
      expect(await waiting).toMatchObject({ timedOut: false })
      await disposing.promise
      expect(order).toEqual(["wait-released", "dispose"])
      expect(controller.signal.aborted).toBe(true)
      expect(tools.get("wait_agent")).toBe(teamWait)
      expect(deps.subagents.roles.get("teammate")).toBeDefined()
      release.resolve(); await closing
      expect(order).toEqual(["wait-released", "dispose", "disposed"])
      expect(tools.get("wait_agent")).toBe(previous)
      expect(deps.subagents.roles.get("teammate")).toBeUndefined()
    } finally { release.resolve(); await closing }
  })

  it("publishes a closing barrier before draining a teammate and preserves a replacement", async () => {
    const deps = makeDeps(), ctx = createContext(), release = Promise.withResolvers<void>()
    const table = deps.subagents.table
    const original = { path: "lead/helper", sessionId: 'replaced-child', status: "running" as const, session: createSession(), controller: new AbortController(), mailbox: [], followupChain: release.promise }
    table.add(original.path, original)
    const handle = await mountAgentTeams(ctx, createToolRegistry(ctx), deps)
    const seen: unknown[] = [], closingEntered = Promise.withResolvers<void>()
    table.subscribe(change => { seen.push({ kind: change.kind, closing: change.entry.closing }); if (change.entry.closing) closingEntered.resolve() })
    const closing = handle.unmount()
    try {
      await closingEntered.promise
      expect(seen).toEqual([{ kind: "update", closing: true }])
      const replacement = { ...original, controller: new AbortController() }
      const agent: Agent = { run: vi.fn(), followup: vi.fn() }
      table.add(original.path, replacement)
      deps.subagents.agents.register(original.sessionId, agent)
      release.resolve(); await closing
      expect(table.get(original.path)).toBe(replacement)
      expect(replacement.controller.signal.aborted).toBe(false)
      expect(deps.subagents.agents.get(original.sessionId)).toBe(agent)
    } finally { release.resolve(); await closing }
  })
  it("makes the generated teammate role available for resident rebuild without persisting it or replacing a custom role", async () => {
    const deps = makeDeps()
    const ctx = createContext()
    const handle = await mountAgentTeams(ctx, createToolRegistry(ctx), deps)
    try {
      expect(deps.subagents.roles.get("teammate")).toMatchObject({ name: "teammate", ephemeral: true })
      expect(snapshotState(deps.subagents).roles.some((role) => role.name === "teammate")).toBe(false)
    } finally { await handle.unmount() }
    expect(deps.subagents.roles.get("teammate")).toBeUndefined()

    const custom = { name: "teammate", description: "custom", systemPrompt: "custom prompt", tools: ["read"], model: { provider: "local", model: "custom" } }
    deps.subagents.roles.register(custom)
    const customCtx = createContext()
    const customHandle = await mountAgentTeams(customCtx, createToolRegistry(customCtx), deps)
    try {
      expect(deps.subagents.roles.get("teammate")).toBe(custom)
      expect(snapshotState(deps.subagents).roles).toContain(custom)
    } finally { await customHandle.unmount() }
    expect(deps.subagents.roles.get("teammate")).toBe(custom)
  })

  it("mount registers the 10 team tools; unmount unregisters them (idempotent)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) }))
    try {
      expect(tools.get("spawn_teammate")).toBeDefined()
      expect(tools.get("team_task_update")).toBeDefined()
      // exactly the 10 team tools — the names derived from createTeamTools, not a
      // hardcoded unregister list (no drift between mount and unmount)
      expect(tools.schemas().map((t) => t.name).sort()).toEqual([...TEAM_TOOL_NAMES].sort())
    } finally {
      await handle.unmount()
    }
    for (const name of TEAM_TOOL_NAMES) expect(tools.get(name)).toBeUndefined()
    await handle.unmount() // idempotent: second unmount is a no-op
  })

  it("throws on a second mount while one is live", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) }))
    try {
      await expect(mountAgentTeams(createContext(), createToolRegistry(createContext()), makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) })))
        .rejects.toThrow(/only one team per run/)
    } finally {
      await handle.unmount() // the live mount must not leak into other tests
    }
    // after the first mount unmounted, a fresh mount works again
    const h2 = await mountAgentTeams(createContext(), createToolRegistry(createContext()), makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) }))
    await h2.unmount()
  })

  it("rejects an invalid config before mounting", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    await expect(mountAgentTeams(ctx, tools, makeDeps(), { maxMembers: 0 }))
      .rejects.toThrow(/maxMembers must be a positive integer/)
    expect(tools.get("spawn_teammate")).toBeUndefined()
  })

  it("replaces subagent tool collisions on mount and restores them on unmount", async () => {
    // Real CLI flow: registerSubagent runs FIRST and mounts send_message /
    // followup_task / wait_agent / interrupt_agent (the subagent surface).
    // The team versions (same names, team semantics) must win during the run
    // and the subagent tools must be back after unmount — a true reverse.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const subagentSend = { name: "send_message", description: "subagent version", inputSchema: {}, isReadOnly: false, execute: async () => ({ queued: true }) }
    const subagentWait = { name: "wait_agent", description: "subagent version", inputSchema: {}, isReadOnly: false, execute: async () => ({ message: "", timed_out: false }) }
    tools.register(subagentSend)
    tools.register(subagentWait)
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) }))
    try {
      const teamSend = tools.get("send_message")
      expect(teamSend?.description).not.toBe("subagent version")
      expect(tools.get("wait_agent")?.description).not.toBe("subagent version")
      expect(tools.get("spawn_teammate")).toBeDefined()
    } finally {
      await handle.unmount()
    }
    // subagent surface restored, team tools gone
    expect(tools.get("send_message")?.description).toBe("subagent version")
    expect(tools.get("interrupt_agent")).toBeUndefined() // not registered by the fixture
    expect(tools.get("spawn_teammate")).toBeUndefined()
  })

  it("deliver fails closed on a throwing write-behind flush — the message stays queued (no ack)", async () => {
    // Ruling 22 fix: the real deliver bridge flushes the target's write-behind
    // and returns FALSE on rejection. The mailbox then keeps the message queued
    // for recoverRoot (at-least-once) instead of acking a maybe-lost message.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const parentSession = createSession()
    // seed an active teammate (folded from the lead log) with a live table entry
    parentSession.events.push(
      { type: "team/member", version: 1, teamId: "lead-t", member: { id: "child-abc", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 1, teamId: "lead-t", member: { id: "child-abc", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active", sessionId: "sess-1" } },
    )
    const table = createAgentTable()
    const child = await ownedTeamFixture([], 'sess-1')
    const entrySession = child.document.view
    table.add("lead/helper", { path: "lead/helper", status: "waiting", session: entrySession, factOwner: child.document, controller: new AbortController(), mailbox: [], sessionId: "sess-1" })
    // coordinator whose flush fails ONLY on the CHILD session ("sess-1") —
    // the parent session log must still commit (that is the queue's
    // durability), while the deliver write-behind durability point fails
    // (write-behind durability failure on the target).
    const actualAppend = child.backend.appendOwnedBatch!
    child.backend.appendOwnedBatch = async (...args) => decodeFactBatch(args[3].bytes).events.some(event => event.type === 'subagent/inbox')
      ? { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' } : actualAppend(...args)
    const deps = makeDeps({
      parentSession,
      subagents: { generationFactoryFor: fixtureGenerationFor,
        table,
        jobs: createJobRegistry(),
        roles: createRoleRegistry(),
        agents: createAgentRegistry(),
        exec: registerExec(createContext()),
        resolveModel: noRoleModel,
        childSessions: { coordinator: child.coordinator, parentSessionId: "lead-parent" },
      },
    })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const send = tools.get("send_message")!
      const out = (await send.execute({ target: "helper", message: "hi helper" }, {})) as { status: string; messageId: string }
      expect(out.status).toBe("queued")
      expect(out.messageId).toMatch(/^msg-/)
      // the message was queued in the lead log but NEVER acked — recoverRoot
      // will retry it (durability failure is not treated as delivered)
      expect(parentSession.events.filter((e) => e.type === "team/message/queued")).toHaveLength(1)
      expect(parentSession.events.filter((e) => e.type === "team/message/delivered")).toHaveLength(0)
      expect(entrySession.events).toEqual([])
    } finally {
      child.backend.appendOwnedBatch = actualAppend
      await handle.unmount()
      await child.coordinator.close()
    }
  })

  it("restore path derives the canonical teamId from the log and recovers lead-targeted messages", async () => {
    // Ruling 22 fix: a fresh randomly-minted teamId on restore would strand
    // every queued message whose targetId is the OLD lead id (recoverRoot
    // would resolve that id to nobody and never deliver). The canonical
    // teamId comes from the first team/* event in the folded log.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const parentSession = createSession()
    // a previous run's committed log: the queued message targets the OLD lead
    // id "lead-abc" and was never acked (no team/message/delivered after it)
    parentSession.events.push({
      type: "team/message/queued", version: 1, teamId: "lead-abc",
      message: { id: "msg-old", senderId: "child-z", senderName: "helper", targetId: "lead-abc", delivery: "wakeup", content: "report" },
    })
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ parentSession }))
    try {
      // the canonical lead id was NOT regenerated
      expect(handle.teamName).toBe("lead-abc")
      // recoverRoot delivered the old-lead-targeted message and acked it
      const delivered = parentSession.events.find((e) => e.type === "team/message/delivered")
      expect(delivered).toBeDefined()
      expect((delivered as { messageId: string }).messageId).toBe("msg-old")
    } finally {
      await handle.unmount()
    }
  })

  it("restore path deliver to the canonical lead still fails closed on a throwing flush", async () => {
    // Lead branch of realDeliver (Ruling 22): even though the canonical
    // teamId resolves, a throwing write-behind flush must NOT ack — the
    // message stays queued for the next recoverRoot.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const owned = await ownedTeamFixture([{
      type: "team/message/queued", version: 1, teamId: "lead-abc",
      message: { id: "msg-old", senderId: "child-z", senderName: "helper", targetId: "lead-abc", delivery: "wakeup", content: "report" },
    }])
    const parentSession = owned.document.view, actualAppend = owned.backend.appendOwnedBatch!
    owned.backend.appendOwnedBatch = async (...args) => decodeFactBatch(args[3].bytes).events.some(event => event.type === 'subagent/inbox')
      ? { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' } : actualAppend(...args)
    const deps = makeDeps({
      parentSession,
      factOwner: owned.document,
      subagents: { generationFactoryFor: fixtureGenerationFor,
        table: createAgentTable(),
        jobs: createJobRegistry(),
        roles: createRoleRegistry(),
        agents: createAgentRegistry(),
        exec: registerExec(createContext()),
        resolveModel: noRoleModel,
        childSessions: { coordinator: owned.coordinator, parentSessionId: "lead-parent" },
      },
    })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      expect(handle.teamName).toBe("lead-abc")
      // deliver appended the inbox event but the flush threw → delivered false
      // → no team/message/delivered ack; recoverRoot retries it next mount
      const deliv = parentSession.events.filter((e) => e.type === "team/message/delivered")
      expect(deliv).toHaveLength(0)
      expect(parentSession.events.filter((e) => e.type === "team/message/queued")).toHaveLength(1)
    } finally {
      owned.backend.appendOwnedBatch = actualAppend
      await handle.unmount()
      await owned.coordinator.close()
    }
  })

  it("resolveCaller maps a teammate ToolExec.sessionId to the exact member identity", async () => {
    // M19 Ruling 24: a teammate's tool call carries the durable child session
    // id on ToolExec.sessionId. The scheduler must resolve it to the MEMBER
    // (roster id + name), never to the lead — otherwise a teammate's
    // send_message to "lead" is falsely rejected as TEAM_SELF_MESSAGE (the
    // old resolve-callers-to-lead behavior), and a message to another
    // teammate is recorded with the LEAD's senderId/senderName.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const parentSession = createSession()
    parentSession.events.push(
      { type: "team/member", version: 1, teamId: "lead-123", member: { id: "child-a", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 1, teamId: "lead-123", member: { id: "child-a", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active", sessionId: "sess-helper" } },
      { type: "team/member", version: 1, teamId: "lead-123", member: { id: "child-b", name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 1, teamId: "lead-123", member: { id: "child-b", name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "active", sessionId: "sess-worker" } },
    )
    const table = createAgentTable()
    const entryHelper = createSession()
    const entryWorker = createSession()
    table.add("lead/helper", { path: "lead/helper", status: "waiting", session: entryHelper, controller: new AbortController(), mailbox: [], sessionId: "sess-helper" })
    table.add("lead/worker", { path: "lead/worker", status: "waiting", session: entryWorker, controller: new AbortController(), mailbox: [], sessionId: "sess-worker" })
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ parentSession, subagents: { ...makeDeps().subagents, table } }))
    try {
      const send = tools.get("send_message")!
      // 1) helper → lead: succeeds (no TEAM_SELF_MESSAGE) and is recorded with
      //    the MEMBER's identity, not teamId/"lead".
      const out1 = (await send.execute({ target: "lead", message: "status" }, { sessionId: "sess-helper" })) as { status: string }
      expect(out1.status).toBe("accepted")
      const m1 = parentSession.events.find((e) => e.type === "team/message/queued")?.message as { senderId: string; senderName: string; targetId: string }
      expect(m1.senderId).toBe("child-a")
      expect(m1.senderName).toBe("helper")
      expect(m1.targetId).toBe("lead-123")
      // 2) helper → worker: member-to-member message carries the member ids.
      const out2 = (await send.execute({ target: "worker", message: "task" }, { sessionId: "sess-helper" })) as { status: string }
      expect(out2.status).toBe("accepted")
      const m2 = parentSession.events.filter((e) => e.type === "team/message/queued")[1]?.message as { senderId: string; senderName: string; targetId: string }
      expect(m2.senderId).toBe("child-a")
      expect(m2.senderName).toBe("helper")
      expect(m2.targetId).toBe("child-b")
      // 3) helper → helper (self): the member identity is EXACT, so it is
      //    rejected — with caller.id = teamId this check could never fire.
      await expect(send.execute({ target: "helper", message: "self" }, { sessionId: "sess-helper" })).rejects.toThrow(/cannot message yourself/)
      // 4) the LEAD's session id (parent) resolves to the lead, not a member.
      const out4 = (await send.execute({ target: "helper", message: "go" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out4.status).toBe("accepted")
      const m4 = parentSession.events.filter((e) => e.type === "team/message/queued").at(-1)?.message as { senderId: string; senderName: string }
      expect(m4.senderId).toBe("lead-123")
      expect(m4.senderName).toBe("lead")
    } finally {
      await handle.unmount()
    }
  })

  it("spawn_teammate threads fork_turns to the spawn bridge", async () => {
    // M19 Ruling 27: the roster bound fork_turns to the tool but the bridge
    // call dropped it. With the seam override we observe the LAST argument:
    // fork_turns: "3" (string from the tool) must reach the bridge normalized
    // to forkTurns: 3 with context "fork".
    let seen: { context: string; opts?: { forkTurns?: "none" | "all" | number } } | undefined
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const handle = await mountAgentTeams(ctx, tools, makeDeps({
      childSessionHoldsPrompt: async () => true,
      spawnChild: async (name, _prompt, context, opts) => {
        seen = { context, opts }
        return { path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }
      },
    }))
    try {
      const spawn = tools.get("spawn_teammate")!
      const out = (await spawn.execute({ name: "helper", description: "d", prompt: "work", context: "fork", fork_turns: "3" }, {})) as { member: { name: string } }
      expect(out.member.name).toBe("helper")
      expect(seen).toEqual({ context: "fork", opts: { forkTurns: 3 } })
    } finally {
      await handle.unmount()
    }
  })

  it("wait_agent wakes on the spawn-completion status edge (running→waiting)", async () => {
    // M19 Ruling 26: a child's initial turn completing after spawn flips its
    // status running→waiting WITHOUT appending any team event — a wait_agent
    // waiter registered during the turn would otherwise sleep until timeout.
    // The REAL spawn bridge + REAL agent loop are used with a gated mock
    // model: the child's turn is HELD (table status "running") until the wait
    // has registered, then released — the edge fires while the waiter is
    // inside its wait, deterministically. The roster's durability checkpoint
    // is satisfied by an in-memory coordinator (write-behind mirror
    // semantics: enqueue + flush + load).
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const parentSession = createSession()

    const owned = await ownedTeamFixture([], 'sess-parent')
    const coordinator = owned.coordinator

    // The child's turn blocks on the gate, so it is provably still RUNNING
    // while wait_agent below registers (spawn returns after the agent started,
    // not after it finished).
    let releaseTurn!: () => void
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve })
    const gatedModel: ModelClient = controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
        await turnGate
        yield { type: "text/chunk", text: "child turn done" }
        yield { type: "end" }
      })

    const handle = await mountAgentTeams(ctx, tools, makeDeps({
      parentSession,
      parentModel: gatedModel,
      subagents: { generationFactoryFor: fixtureGenerationFor,
        table: createAgentTable(),
        jobs: createJobRegistry(),
        roles: createRoleRegistry(),
        agents: createAgentRegistry(),
        exec: registerExec(createContext()),
        resolveModel: noRoleModel,
        childSessions: { coordinator, parentSessionId: "sess-parent" },
      },
    }))
    try {
      const spawn = tools.get("spawn_teammate")!
      const out = (await spawn.execute({ name: "helper", description: "d", prompt: "work" }, {})) as { member: { name: string } }
      expect(out.member.name).toBe("helper")
      // The default timeout is 30s; the wait MUST resolve on the edge long
      // before it.
      const wait = tools.get("wait_agent")!
      const waitP = wait.execute({ timeout_ms: 30_000 }, {})
      releaseTurn() // now the child's turn completes → running→waiting edge
      const res = (await waitP) as { timedOut: boolean }
      expect(res.timedOut).toBe(false)
    } finally {
      // The completion notification was accepted before retirement, but its
      // queued driver may reach the open guard after the wait edge wakes us.
      // Report that original failure once; it is not continuing cleanup debt.
      const closed = await handle.unmount().then(() => ({ errors: [] as unknown[] }), error => error as AggregateError)
      for (const error of closed.errors) expect(error).toMatchObject({ code: 'FACT_CLOSED' })
      await expect(handle.unmount()).resolves.toBeUndefined()
      await coordinator.close()
    }
  })

  // M23 (Minor 4): after a resume the subagent Agent registry is fresh-empty
  // and restoreState maps a running/waiting teammate to status "error" — the
  // old realDeliver gate rejected such targets outright, so a pre-resume
  // wakeup stayed queued forever (recoverRoot retried into the same gate).
  // With TeamSubagentDeps.ensureResident injected (run.ts wires registerSubagent's
  // lazy rebuild), the gate rebuilds the resident agent first and the wakeup
  // drive actually runs.
  function errorTeammateFixture() {
    const parentSession = createSession()
    parentSession.events.push(
      { type: "team/member", version: 1, teamId: "lead-t", member: { id: "child-abc", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 1, teamId: "lead-t", member: { id: "child-abc", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active", sessionId: "sess-1" } },
    )
    const table = createAgentTable()
    const entrySession = createSession()
    // restoreState shape: running/waiting → "error", no resident agent.
    table.add("lead/helper", { path: "lead/helper", status: "error", session: entrySession, controller: new AbortController(), mailbox: [], sessionId: "sess-1", roleName: "general" })
    return { parentSession, table, entrySession }
  }

  it("realDeliver keeps the conservative queue behavior for an error-status teammate WITHOUT the rebuild seam", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const { parentSession, table, entrySession } = errorTeammateFixture()
    const deps = makeDeps({ parentSession, subagents: { ...makeDeps().subagents, table } })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const follow = tools.get("followup_task")!
      const out = (await follow.execute({ target: "helper", message: "wake" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out.status).toBe("queued") // not delivered → recoverRoot retries
      expect(entrySession.events.filter((e) => e.type === "subagent/inbox")).toHaveLength(0)
      expect(parentSession.events.filter((e) => e.type === "team/message/delivered")).toHaveLength(0)
    } finally {
      await handle.unmount()
    }
  })

  it("realDeliver rebuilds an error-status teammate via ensureResident and the wakeup drive runs", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const { parentSession, table, entrySession } = errorTeammateFixture()
    const agents = createAgentRegistry()
    // The lazy rebuild (mirrors registerSubagent's ensureResident): registers
    // a live agent whose followup runs the wakeup turn.
    const followup = vi.fn().mockResolvedValue({ finalText: "woken", turns: 1, reasoning: [] })
    const fakeAgent: Agent = { run: vi.fn(), followup }
    const ensureResident = async (entry: { sessionId?: string }) => {
      if (!entry.sessionId) return false
      agents.register(entry.sessionId, fakeAgent)
      return true
    }
    const deps = makeDeps({ parentSession, subagents: { ...makeDeps().subagents, table, agents, ensureResident } })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const follow = tools.get("followup_task")!
      const out = (await follow.execute({ target: "helper", message: "wake" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out.status).toBe("accepted") // delivered after the rebuild
      // the inbox append went through the child's session mirror
      expect(entrySession.events.filter((e) => e.type === "subagent/inbox")).toHaveLength(1)
      expect(parentSession.events.filter((e) => e.type === "team/message/delivered")).toHaveLength(1)
      // the wakeup drive ran a followup turn on the REBUILT resident agent
      await vi.waitFor(() => expect(followup).toHaveBeenCalledWith(expect.stringContaining("wake"), expect.any(AbortSignal), { provenance: { kind: "child-report", authority: "observation", scope: "turn", producer: "team.delivery" } }))
    } finally {
      await handle.unmount()
    }
  })

  it("realDeliver keeps the message queued when ensureResident cannot rebuild", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const { parentSession, table, entrySession } = errorTeammateFixture()
    const deps = makeDeps({
      parentSession,
      subagents: { ...makeDeps().subagents, table, ensureResident: async () => false },
    })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const follow = tools.get("followup_task")!
      const out = (await follow.execute({ target: "helper", message: "wake" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out.status).toBe("queued")
      expect(entrySession.events.filter((e) => e.type === "subagent/inbox")).toHaveLength(0)
      expect(parentSession.events.filter((e) => e.type === "team/message/delivered")).toHaveLength(0)
    } finally {
      await handle.unmount()
    }
  })

  it("realDeliver still refuses a killed teammate even with the rebuild seam", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const { parentSession, table, entrySession } = errorTeammateFixture()
    table.get("lead/helper")!.status = "killed"
    let rebuildCalls = 0
    const deps = makeDeps({
      parentSession,
      subagents: { ...makeDeps().subagents, table, ensureResident: async () => { rebuildCalls++; return true } },
    })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const follow = tools.get("followup_task")!
      const out = (await follow.execute({ target: "helper", message: "wake" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out.status).toBe("queued")
      expect(rebuildCalls).toBe(0) // killed short-circuits BEFORE any rebuild attempt
      expect(entrySession.events.filter((e) => e.type === "subagent/inbox")).toHaveLength(0)
    } finally {
      await handle.unmount()
    }
  })

  // The team spawn is one of the assembly's three role-carrying spawn sites, so
  // the real bridge must forward `roleSelectionFor` + the switch to spawnChild
  // exactly as registerSubagent does. Without them the declared selection
  // collapsed to the role's own (undefined) model — no gate, no message, the
  // teammate inherited the parent's client — while the SAME teammate's
  // wakeup/rebuild went through ensureResident with the full deps and resolved
  // the declared one. One teammate, two models.
  it("the real teammate spawn resolves the SETTINGS-declared selection", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    // Durable child sessions are a roster precondition (spawn must return a
    // sessionId and the checkpoint must pass) — an in-memory coordinator keeps
    // the REAL bridge under test.
    const owned = await ownedTeamFixture([], 'sess-parent')
    const coordinator = owned.coordinator
    const calls: Array<{ provider: string; model: string }> = []
    const handle = await mountAgentTeams(ctx, tools, makeDeps({
      childSessionHoldsPrompt: async () => true,
      subagents: { generationFactoryFor: fixtureGenerationFor,
        ...makeDeps().subagents,
        childSessions: { coordinator, parentSessionId: "sess-parent" },
        allowSubagentModelSelection: true,
        roleSelectionFor: (roleName) => (roleName === "teammate" ? { provider: "gw", model: "small" } : undefined),
        resolveModel: async (selection) => {
          calls.push(selection)
          return { status: "ready" as const, binding: { client: model() } }
        },
      },
    }))
    try {
      const spawn = tools.get("spawn_teammate")!
      const out = (await spawn.execute({ name: "helper", description: "d", prompt: "work" }, {})) as { member: { name: string } }
      expect(out.member.name).toBe("helper")
      // The DECLARED selection is what the spawn asked the resolver for — the
      // same value the wakeup/rebuild path resolves.
      expect(calls).toEqual([{ provider: "gw", model: "small" }])
    } finally {
      await handle.unmount()
      await coordinator.close()
    }
  }, 15_000)
})
