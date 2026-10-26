import { expect, it } from 'vitest'
import { createSession, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createAgent, createAgentRegistry } from '@i-harness/core-agent'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createAgentTable, createJobRegistry, ParentNotificationStoppedError, type ChildAgentEntry } from '@i-harness/subagent'
import { createTaskDelivery } from '../src/scheduler/task-delivery.ts'
import { createTeamFacts } from '../src/facts.ts'
import { createTeamTransact } from '../src/transact.ts'
import { createMailbox, type MailboxDeps } from '../src/mailbox.ts'
import { createFoldState } from '../src/fold.ts'
import { ownedTeamFixture } from './owned-fixture.ts'
import type { DeliveryOutcome, Queued } from '../src/transact.ts'

async function fixture(deliver: MailboxDeps['deliver'], maxPendingMessagesPerMember = 64) {
  const f = await ownedTeamFixture()
  const captures: { action: number; kind: string; tuple: unknown; fact: object; source?: object }[] = []
  let actions = 0
  const beginAction = f.document.beginAction
  f.document.beginAction = (...args) => {
    const action = beginAction(...args), id = ++actions
    const captureQueue = action.captureTeamTransaction, register = action.registerSettlementSource
    action.captureTeamTransaction = events => { const fact = captureQueue(events); captures.push({ action: id, kind: 'queue', tuple: events, fact }); return fact }
    action.registerSettlementSource = (...args) => {
      const source = register(...args), capture = source.delivery.capture
      source.delivery.capture = event => { const fact = capture(event); captures.push({ action: id, kind: 'delivery', tuple: event, fact, source }); return fact }
      return source
    }
    return action
  }
  const state = createFoldState()
  state.members.set('helper', { id: 'child', name: 'helper', description: '', provider: 'fixture', context: 'fresh', phase: 'active' })
  const lead = createTeamFacts(f.document, () => tx.drain(), () => {})
  const tx = createTeamTransact(lead, state)
  const mailbox = createMailbox({ teamId: 'team', state, transact: tx, deliver, memberStatus: () => 'idle', maxPendingMessagesPerMember })
  const send = () => mailbox.sendMessage({ id: 'team', name: 'lead', role: 'lead' }, 'helper', 'hello', 'quiet')
  return { ...f, lead, tx, state, mailbox, send, captures, actionCount: () => actions }
}

it('holds source close until actual consumption and captures exactly one required ack after revocation', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<DeliveryOutcome>()
  const f = await fixture(async () => { entered.resolve(); return release.promise })
  const captured: unknown[] = [], actual = f.backend.appendOwnedBatch!
  f.backend.appendOwnedBatch = async (...args) => { const outcome = await actual(...args); captured.push({ batch: decodeFactBatch(args[3].bytes), outcome }); return outcome }
  const sending = f.send()
  await entered.promise
  let closed = false
  const closing = f.lead.close().then(() => { closed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(closed).toBe(false)
  expect(f.document.view.events.map(e => e.type)).toEqual(['team/message/queued'])
  release.resolve({ kind: 'consumed', via: 'target', sendFailure: { occurred: false } })
  try {
    expect(await sending).toMatchObject({ status: 'accepted' })
    await closing
    expect(f.document.view.events.map(e => e.type)).toEqual(['team/message/queued', 'team/message/delivered'])
    expect(captured).toHaveLength(2)
    expect(f.state.delivered.size).toBe(1)
    expect(f.actionCount()).toBe(2) // source registration + original optional queue, no ack beginAction
    expect(f.captures.map(capture => [capture.action, capture.kind])).toEqual([[2, 'queue'], [1, 'delivery']])
    console.info('held-consumption-capture-evidence', JSON.stringify({ root: f.root, batches: captured, captures: f.captures.map(({ action, kind, tuple }, identity) => ({ action, kind, tuple, captureIdentity: identity + 1 })) }))
  } finally { release.resolve({ kind: 'queued', via: 'bridge-false', sendFailure: { occurred: false } }); await f.coordinator.close().catch(() => {}) }
})

it('serializes real max1 admission before reserving or calling a second delivery', async () => {
  let calls = 0, writes = 0
  const f = await fixture(async () => { calls++; return { kind: 'queued', via: 'bridge-false', sendFailure: { occurred: false } } }, 1)
  const actual = f.backend.appendOwnedBatch!
  f.backend.appendOwnedBatch = async (...args) => { writes++; return actual(...args) }
  try {
    const results = await Promise.allSettled([f.send(), f.send()])
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'queued' } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'TEAM_MAILBOX_FULL' } })
    expect([calls, writes, f.state.queued.get('child')?.length, f.state.delivered.size]).toEqual([1, 1, 1, 0])
    await f.lead.close()
  } finally { await f.coordinator.close().catch(() => {}) }
})

it('refuses message ownership on a generic-only lead without changing generic transactions', async () => {
  const tx = createTeamTransact({ commit: async () => {} })
  await expect(tx.deliverMessage({ queued: { type: 'team/message/queued', version: 1, teamId: 'team', message: { id: 'm', senderId: 'team', senderName: 'lead', targetId: 'child', content: 'hello', delivery: 'quiet' } }, mode: 'enqueue', guard: () => {}, deliver: async () => ({ kind: 'consumed', via: 'target', sendFailure: { occurred: false } }) })).rejects.toMatchObject({ code: 'FACT_OWNER_UNSUPPORTED' })
  expect(await tx.transact(() => ({ result: 42 }))).toBe(42)
})

const Q: Queued = { type: 'team/message/queued', version: 1, teamId: 'team', message: { id: 'fixed', senderId: 'team', senderName: 'lead', targetId: 'child', content: 'hello', delivery: 'quiet' } }
const queued = (): DeliveryOutcome => ({ kind: 'queued', via: 'bridge-false', sendFailure: { occurred: false } })
const consumed = (): DeliveryOutcome => ({ kind: 'consumed', via: 'target', sendFailure: { occurred: false } })

it('joins an exact original tuple before admission and ignores replacement callback; rejects mismatches even after delivered', async () => {
  const release = Promise.withResolvers<DeliveryOutcome>(), entered = Promise.withResolvers<void>()
  const f = await fixture(async () => queued())
  let first = 0, replacement = 0, guards = 0
  const a = f.tx.deliverMessage({ queued: Q, mode: 'enqueue', guard: () => { guards++ }, deliver: async () => { first++; entered.resolve(); return release.promise } })
  await entered.promise
  const b = f.tx.deliverMessage({ queued: structuredClone(Q), mode: 'enqueue', guard: () => { throw new Error('replacement guard') }, deliver: async () => { replacement++; return queued() } })
  await expect(f.tx.deliverMessage({ queued: { ...Q, message: { ...Q.message, content: 'different' } }, mode: 'enqueue', guard: () => {}, deliver: async () => consumed() })).rejects.toThrow(/tuple mismatch/)
  release.resolve(consumed())
  try {
    expect(await a).toEqual(await b)
    expect([first, replacement, guards]).toEqual([1, 0, 1])
    await expect(f.tx.deliverMessage({ queued: { ...Q, message: { ...Q.message, targetId: 'other' } }, mode: 'existing', guard: () => {}, deliver: async () => consumed() })).rejects.toThrow(/tuple mismatch/)
    await f.lead.close()
  } finally { release.resolve(queued()); await f.coordinator.close().catch(() => {}) }
})

it('reconciles an unknown original queue and installs it without calling the failed sends unreached target', async () => {
  let calls = 0, writes = 0, key: BatchKey | undefined
  const f = await fixture(async () => { calls++; return consumed() })
  const actual = f.backend.appendOwnedBatch!
  f.backend.appendOwnedBatch = async (...args) => { writes++; await actual(...args); key = args[3].key; return { kind: 'unknown', key } }
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect([calls, f.state.queued.size]).toEqual([0, 0])
    await f.document.reconcile(key!)
    await f.lead.close()
    expect([calls, writes, f.state.queued.get('child')?.length, f.state.delivered.size]).toEqual([0, 1, 1, 0])
  } finally { await f.coordinator.close().catch(() => {}) }
})

it('keeps an unknown required ack on the same capture and settles close without replaying the caller rejection', async () => {
  let calls = 0, writes = 0, ackKey: BatchKey | undefined
  const f = await fixture(async () => { calls++; return consumed() })
  const actual = f.backend.appendOwnedBatch!
  const outcomes: unknown[] = []
  f.backend.appendOwnedBatch = async (...args) => {
    writes++
    const result = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(e => e.type === 'team/message/delivered')) { ackKey = args[3].key; const reported = { kind: 'unknown' as const, key: ackKey }; outcomes.push({ actual: result, reported }); return reported }
    return result
  }
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(f.state.delivered.size).toBe(0)
    await f.document.reconcile(ackKey!)
    await f.lead.close()
    expect([calls, writes, f.state.delivered.size]).toEqual([1, 2, 1])
    expect(f.document.view.events.filter(e => e.type === 'team/message/delivered')).toHaveLength(1)
    expect(f.captures.filter(capture => capture.kind === 'delivery')).toHaveLength(1)
    console.info('unknown-ack-capture-evidence', JSON.stringify({ root: f.root, ackKey, outcomes, writes, actionCount: f.actionCount(), captures: f.captures.map(({ action, kind, tuple }, identity) => ({ action, kind, tuple, captureIdentity: identity + 1 })) }))
  } finally { await f.coordinator.close().catch(() => {}) }
})

for (const error of [new Error('ensure failed'), undefined, null]) {
  it(`preserves the exact ensureResident rejection (${String(error)}) without target audit or Team ack`, async () => {
    let realDeliver: ReturnType<typeof createTaskDelivery>
    const f = await fixture((...args) => realDeliver(...args))
    const child = await ownedTeamFixture([], 'child')
    const table = createAgentTable(), jobs = createJobRegistry()
    const entry: ChildAgentEntry = { path: 'lead/helper', status: 'error', session: child.document.view, factOwner: child.document, controller: new AbortController(), mailbox: [] }
    table.add(entry.path, entry)
    let rebuilds = 0, targetWrites = 0
    const actual = child.backend.appendOwnedBatch!
    child.backend.appendOwnedBatch = async (...args) => { targetWrites++; return actual(...args) }
    realDeliver = createTaskDelivery('team', f.state, { parentSession: f.document.view, factOwner: f.document }, { table, jobs, agents: createAgentRegistry(), ensureResident: async () => { rebuilds++; throw error } }, jobs, { notify() {} }, () => false)
    try {
      const result = await f.send().then(() => ({ occurred: false }), error => ({ occurred: true, error }))
      expect(result).toEqual({ occurred: true, error })
      await f.lead.close()
      expect([rebuilds, targetWrites, child.document.view.events.length, f.state.delivered.size]).toEqual([1, 0, 0, 0])
      expect(f.state.queued.get('child')).toHaveLength(1)
    } finally { await f.coordinator.close().catch(() => {}); await child.coordinator.close().catch(() => {}) }
  })
}

it('leaves unknown target audit with its original owner while Team close succeeds with no ack', async () => {
  let realDeliver: ReturnType<typeof createTaskDelivery>
  const f = await fixture((...args) => realDeliver(...args))
  const child = await ownedTeamFixture([], 'child')
  const table = createAgentTable(), jobs = createJobRegistry()
  const entry: ChildAgentEntry = { path: 'lead/helper', status: 'waiting', session: child.document.view, factOwner: child.document, controller: new AbortController(), mailbox: [] }
  table.add(entry.path, entry)
  const append = child.backend.appendOwnedBatch!, reconcile = child.backend.reconcileOwnedBatch!
  let writes = 0, reconciles = 0, allow = false
  child.backend.appendOwnedBatch = async (...args) => { writes++; await append(...args); return { kind: 'unknown', key: args[3].key } }
  child.backend.reconcileOwnedBatch = async (...args) => { reconciles++; return allow ? reconcile(...args) : { kind: 'unknown', key: args[3].key } }
  realDeliver = createTaskDelivery('team', f.state, { parentSession: f.document.view, factOwner: f.document }, { table, jobs, agents: createAgentRegistry() }, jobs, { notify() {} }, () => false)
  try {
    expect(await f.send()).toMatchObject({ status: 'queued' })
    const before = reconciles
    await f.lead.close()
    expect(reconciles).toBe(before)
    expect(f.state.delivered.size).toBe(0)
    await expect(child.coordinator.close()).rejects.toThrow()
    allow = true
    await child.coordinator.close()
    expect(writes).toBe(1)
    expect(entry.mailbox).toEqual([])
  } finally { allow = true; await f.coordinator.close().catch(() => {}); await child.coordinator.close().catch(() => {}) }
})

it('recognizes a trusted parent Stop only after target audit, and preserves caught-false wake behavior', async () => {
  const f = await fixture(async () => queued())
  const jobs = createJobRegistry(), table = createAgentTable()
  let stopped = true
  const failure = new Error('wake observer')
  const bridge = createTaskDelivery('team', f.state, {
    parentSession: f.document.view, factOwner: f.document,
    parentNotify: { async admit() { if (stopped) throw new ParentNotificationStoppedError() }, wake() { throw failure } },
  }, { table, jobs, agents: createAgentRegistry() }, jobs, { notify() {} }, () => false)
  try {
    expect(await bridge('team', 'stop', 'hello', 'quiet')).toEqual({ kind: 'consumed', via: 'parent-stop', sendFailure: { occurred: false } })
    stopped = false
    expect(await bridge('team', 'wake', 'hello', 'quiet')).toEqual({ kind: 'queued', via: 'target-owned', sendFailure: { occurred: false } })
    await f.lead.close()
  } finally { await f.coordinator.close().catch(() => {}) }
})

it('never treats a matching admission error code or a wake-thrown Stop as parent-stop consumption', async () => {
  const f = await fixture(async () => queued())
  const jobs = createJobRegistry(), table = createAgentTable()
  let admitted = false
  const bridge = createTaskDelivery('team', f.state, {
    parentSession: f.document.view, factOwner: f.document,
    parentNotify: {
      async admit() { if (!admitted) throw Object.assign(new Error('lookalike'), { code: 'PARENT_NOTIFICATION_STOPPED' }) },
      wake() { throw new ParentNotificationStoppedError() },
    },
  }, { table, jobs, agents: createAgentRegistry() }, jobs, { notify() {} }, () => false)
  try {
    expect(await bridge('team', 'code', 'hello', 'quiet')).toEqual({ kind: 'queued', via: 'target-owned', sendFailure: { occurred: false } })
    admitted = true
    expect(await bridge('team', 'wake-stop', 'hello', 'quiet')).toEqual({ kind: 'queued', via: 'target-owned', sendFailure: { occurred: false } })
    await f.lead.close()
  } finally { await f.coordinator.close().catch(() => {}) }
})

for (const error of [undefined, null]) {
  it(`acknowledges proven parent consumption while preserving escaping observer ${String(error)}`, async () => {
    const f = await fixture(async () => queued())
    const jobs = createJobRegistry(), table = createAgentTable()
    const bridge = createTaskDelivery('team', f.state, { parentSession: f.document.view, factOwner: f.document }, { table, jobs, agents: createAgentRegistry() }, jobs, { notify() { throw error } }, () => false)
    try {
      const result = await f.tx.deliverMessage({ queued: { ...Q, message: { ...Q.message, targetId: 'team' } }, mode: 'enqueue', guard: () => {}, deliver: () => bridge('team', 'fixed', 'hello', 'quiet') }).then(() => ({ occurred: false }), error => ({ occurred: true, error }))
      expect(result).toEqual({ occurred: true, error })
      await f.lead.close()
      expect(f.state.delivered.size).toBe(1)
      expect(f.document.view.events.map(e => e.type)).toEqual(['team/message/queued', 'subagent/inbox', 'team/message/delivered'])
    } finally { await f.coordinator.close().catch(() => {}) }
  })
}

it('retries a target-owned unknown audit only through an explicit OPEN recovery and reuses its original capture', async () => {
  let realDeliver: ReturnType<typeof createTaskDelivery>
  const f = await fixture((...args) => realDeliver(...args))
  const child = await ownedTeamFixture([], 'child')
  const jobs = createJobRegistry(), table = createAgentTable()
  const entry: ChildAgentEntry = { path: 'lead/helper', status: 'waiting', session: child.document.view, factOwner: child.document, controller: new AbortController(), mailbox: [], lastInboxSeq: -1 }
  table.add(entry.path, entry)
  const append = child.backend.appendOwnedBatch!, reconcile = child.backend.reconcileOwnedBatch!
  let allow = false, writes = 0
  child.backend.appendOwnedBatch = async (...args) => { writes++; await append(...args); return { kind: 'unknown', key: args[3].key } }
  child.backend.reconcileOwnedBatch = async (...args) => allow ? reconcile(...args) : { kind: 'unknown', key: args[3].key }
  realDeliver = createTaskDelivery('team', f.state, { parentSession: f.document.view, factOwner: f.document }, { table, jobs, agents: createAgentRegistry() }, jobs, { notify() {} }, () => false)
  try {
    const result = await f.send()
    expect(result.status).toBe('queued')
    allow = true
    await f.mailbox.recoverRoot()
    expect(f.state.delivered.has(result.messageId)).toBe(true)
    expect(child.document.view.events.filter(e => e.type === 'subagent/inbox')).toEqual([expect.objectContaining({ messageId: result.messageId })])
    expect([writes, entry.lastInboxSeq, entry.mailbox.length]).toEqual([1, -1, 1])
    await f.mailbox.recoverRoot()
    expect([writes, entry.lastInboxSeq, entry.mailbox.length]).toEqual([1, -1, 1])
    await f.lead.close()
  } finally { allow = true; await f.coordinator.close().catch(() => {}); await child.coordinator.close().catch(() => {}) }
})

for (const debt of ['absent', 'conflict'] as const) {
  it(`retains the original ack on ${debt} without a reissue or callback replay`, async () => {
    let calls = 0, writes = 0, allow = false
    const f = await fixture(async () => { calls++; return consumed() })
    const append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
    f.backend.appendOwnedBatch = async (...args) => {
      writes++
      const result = await append(...args)
      return decodeFactBatch(args[3].bytes).events.some(e => e.type === 'team/message/delivered') ? { kind: 'unknown', key: args[3].key } : result
    }
    f.backend.reconcileOwnedBatch = async (...args) => allow ? reconcile(...args) : { kind: debt, key: args[3].key }
    try {
      await expect(f.send()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      await expect(f.lead.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      expect([calls, writes, f.state.delivered.size]).toEqual([1, 2, 0])
      allow = true
      if (debt === 'absent') {
        // Native captured absence is terminal until an explicitly authorized
        // source retry; Team cleanup has no authority to issue a replacement.
        await expect(f.lead.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
        expect([calls, writes, f.state.delivered.size]).toEqual([1, 2, 0])
      } else {
        await f.lead.close()
        expect([calls, writes, f.state.delivered.size]).toEqual([1, 2, 1])
      }
      expect(f.captures.filter(c => c.kind === 'delivery')).toHaveLength(1)
    } finally { allow = true; await f.coordinator.close().catch(() => {}) }
  })
}

for (const debt of ['absent', 'conflict'] as const) {
  it(`keeps ${debt} queue debt on the original record and never reaches its target`, async () => {
    let calls = 0, writes = 0, allow = false
    const f = await fixture(async () => { calls++; return consumed() })
    const append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
    f.backend.appendOwnedBatch = async (...args) => { writes++; await append(...args); return { kind: 'unknown', key: args[3].key } }
    f.backend.reconcileOwnedBatch = async (...args) => allow ? reconcile(...args) : { kind: debt, key: args[3].key }
    try {
      await expect(f.send()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      await expect(f.lead.close()).rejects.toThrow()
      expect([calls, writes, f.state.queued.size, f.state.delivered.size]).toEqual([0, 1, 0, 0])
      allow = true
      if (debt === 'absent') await expect(f.lead.close()).rejects.toThrow()
      else {
        await f.lead.close()
        expect(f.state.queued.get('child')).toHaveLength(1)
      }
      expect([calls, writes, f.state.delivered.size]).toEqual([0, 1, 0])
      expect(f.captures.map(c => c.kind)).toEqual(['queue'])
    } finally { allow = true; await f.coordinator.close().catch(() => {}) }
  })
}

it('recovers local queue installation debt without running the failed original target', async () => {
  let calls = 0, writes = 0
  const f = await fixture(async () => { calls++; return consumed() })
  const append = f.backend.appendOwnedBatch!
  f.backend.appendOwnedBatch = async (...args) => {
    writes++
    const outcome = await append(...args)
    // The journal commits, but this live projection cannot accept the insert.
    f.state.queued.set('child', Object.freeze([]) as unknown as typeof Q.message[])
    return outcome
  }
  try {
    await expect(f.send()).rejects.toThrow()
    expect(f.document.view.events.map(e => e.type)).toEqual(['team/message/queued'])
    f.state.queued.set('child', [])
    await f.lead.close()
    expect([calls, writes, f.state.queued.get('child')?.length, f.state.delivered.size]).toEqual([0, 1, 1, 0])
  } finally { await f.coordinator.close().catch(() => {}) }
})

it('recovers local ack installation debt on the exact original capture without a new action', async () => {
  const f = await fixture(async () => consumed())
  const add = f.state.delivered.add
  const failure = new Error('live ack fold unavailable')
  f.state.delivered.add = () => { throw failure }
  try {
    await expect(f.send()).rejects.toBe(failure)
    expect(f.state.delivered.size).toBe(0)
    f.state.delivered.add = add
    await f.lead.close()
    expect(f.state.delivered.size).toBe(1)
    expect(f.actionCount()).toBe(2)
    expect(f.captures.filter(c => c.kind === 'delivery')).toHaveLength(1)
    expect(f.document.view.events.filter(e => e.type === 'team/message/delivered')).toHaveLength(1)
  } finally { f.state.delivered.add = add; await f.coordinator.close().catch(() => {}) }
})

it('seals admission during held delivery without allocating a second optional action', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<DeliveryOutcome>()
  const f = await fixture(async () => { entered.resolve(); return release.promise })
  const send = f.send()
  await entered.promise
  const close = f.lead.close()
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'FACT_CLOSED' })
    expect(f.actionCount()).toBe(2)
    release.resolve(consumed())
    await send; await close
    expect(f.state.delivered.size).toBe(1)
  } finally { release.resolve(queued()); await f.coordinator.close().catch(() => {}) }
})

it('deduplicates repeated child delivery by inbox messageId and lastInboxSeq without executing another turn', async () => {
  const f = await fixture(async () => queued())
  const session = createSession(), ctx = createContext(), table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry()
  let turns = 0
  const agent = createAgent(ctx, {
    session, tools: createToolRegistry(ctx), systemPrompt: 'Fixture child',
    model: controlledModel(async function* () { turns++; yield { type: 'text/chunk', text: 'received' }; yield { type: 'end' } }),
  })
  const entry: ChildAgentEntry = { path: 'lead/helper', sessionId: 'child', status: 'waiting', session, controller: new AbortController(), mailbox: [] }
  table.add(entry.path, entry); agents.register('child', agent)
  const bridge = createTaskDelivery('team', f.state, { parentSession: f.document.view, factOwner: f.document }, { table, jobs, agents }, jobs, { notify() {} }, () => false)
  try {
    expect(await bridge('child', 'same', 'hello', 'wakeup')).toEqual(consumed())
    await entry.followupChain
    expect(turns).toBe(1)
    const seq = entry.lastInboxSeq
    expect(seq).toBeGreaterThanOrEqual(0)
    expect(await bridge('child', 'same', 'hello', 'wakeup')).toEqual(consumed())
    await entry.followupChain
    expect([turns, entry.lastInboxSeq, session.events.filter(e => e.type === 'subagent/inbox').length]).toEqual([1, seq, 1])
    await f.lead.close()
  } finally { await f.coordinator.close().catch(() => {}) }
})

for (const disposition of ['missing', 'no-rebuild', 'rebuild-false', 'killed'] as const) {
  it(`keeps ${disposition} target queued without attempting a message audit`, async () => {
    let bridge: ReturnType<typeof createTaskDelivery>
    const f = await fixture((...args) => bridge(...args))
    const child = await ownedTeamFixture([], 'child')
    const jobs = createJobRegistry(), table = createAgentTable()
    let audits = 0, rebuilds = 0
    const append = child.backend.appendOwnedBatch!
    child.backend.appendOwnedBatch = async (...args) => { audits++; return append(...args) }
    if (disposition !== 'missing') table.add('lead/helper', { path: 'lead/helper', status: disposition === 'killed' ? 'killed' : 'error', session: child.document.view, factOwner: child.document, controller: new AbortController(), mailbox: [] })
    bridge = createTaskDelivery('team', f.state, { parentSession: f.document.view, factOwner: f.document }, {
      table, jobs, agents: createAgentRegistry(), ...(disposition === 'rebuild-false' ? { ensureResident: async () => { rebuilds++; return false } } : {}),
    }, jobs, { notify() {} }, () => false)
    try {
      expect(await f.send()).toMatchObject({ status: 'queued' })
      await f.lead.close()
      expect([audits, rebuilds, f.state.delivered.size]).toEqual([0, disposition === 'rebuild-false' ? 1 : 0, 0])
      expect(f.state.queued.get('child')).toHaveLength(1)
    } finally { await f.coordinator.close().catch(() => {}); await child.coordinator.close().catch(() => {}) }
  })
}

it('settles a failed original queue without dispatch, then permits a separate explicit OPEN recovery attempt', async () => {
  let calls = 0, key: BatchKey | undefined, first = true
  const f = await fixture(async () => { calls++; return consumed() })
  const append = f.backend.appendOwnedBatch!
  f.backend.appendOwnedBatch = async (...args) => {
    const outcome = await append(...args)
    if (first) { first = false; key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await f.document.reconcile(key!)
    await f.tx.drain() // settles the original lane, with admission still OPEN
    expect([calls, f.state.queued.get('child')?.length, f.state.delivered.size]).toEqual([0, 1, 0])
    await f.mailbox.recoverRoot()
    expect([calls, f.state.delivered.size]).toEqual([1, 1])
    expect(f.actionCount()).toBe(3) // source + original queue + explicit retry admission
    await f.lead.close()
  } finally { await f.coordinator.close().catch(() => {}) }
})

it('releases an authoritative never-issued queue with its native refusal and accepts later optional work', async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; return queued() })
  const append = f.backend.appendOwnedBatch!
  let first = true
  f.backend.appendOwnedBatch = async (...args) => {
    if (first) { first = false; throw Object.assign(new Error('pre-issue guard'), { code: 'FACT_PRECONDITION_STALE' }) }
    return append(...args)
  }
  try {
    await expect(f.send()).rejects.toMatchObject({ code: 'FACT_PRECONDITION_STALE', outcome: { kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' } })
    expect([calls, f.state.queued.size, f.document.view.events.length]).toEqual([0, 0, 0])
    expect(await f.send()).toMatchObject({ status: 'queued' })
    expect(calls).toBe(1)
    await f.lead.close()
  } finally { await f.coordinator.close().catch(() => {}) }
})

it('never dispatches a failed original queue observer on a duplicate retry or close', async () => {
  let calls = 0, notifications = 0
  const failure = new Error('queue observer')
  const f = await fixture(async () => queued())
  f.lead.onCommit = () => { if (++notifications === 1) throw failure }
  const request = { queued: Q, mode: 'enqueue' as const, guard: () => {}, deliver: async () => { calls++; return consumed() } }
  try {
    await expect(f.tx.deliverMessage(request)).rejects.toBe(failure)
    await expect(f.tx.deliverMessage({ ...request, mode: 'existing' })).rejects.toBe(failure)
    await f.lead.close()
    expect([calls, f.state.queued.get('child')?.length, f.state.delivered.size]).toEqual([0, 1, 0])
  } finally { await f.coordinator.close().catch(() => {}) }
})

for (const error of [undefined, null]) {
  it(`does not reapply an installed ack after an observer throws ${String(error)}`, async () => {
    const f = await fixture(async () => consumed())
    let notifications = 0
    f.lead.onCommit = () => { if (++notifications === 2) throw error }
    try {
      expect(await f.send().then(() => ({ occurred: false }), error => ({ occurred: true, error }))).toEqual({ occurred: true, error })
      expect(f.state.delivered.size).toBe(1)
      await f.lead.close()
      expect(notifications).toBe(2)
      expect(f.document.view.events.filter(e => e.type === 'team/message/delivered')).toHaveLength(1)
    } finally { await f.coordinator.close().catch(() => {}) }
  })
}
