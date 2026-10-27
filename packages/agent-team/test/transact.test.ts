import { describe, expect, it } from "vitest"
import { createTeamFacts } from '../src/facts.ts'
import { ownedTeamFixture } from './owned-fixture.ts'
import { type BatchKey } from '@i-harness/core-session'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTeamTransact, createFoldState, foldTeam } from "../src/index.ts"
import type { TeamEvent } from "../src/index.ts"

function fakeLead(opts?: { flush?: () => Promise<void> }) {
  const events: TeamEvent[] = []
  const appended=new WeakSet<object>()
  return {
    events,
    async commit(candidate:readonly TeamEvent[]){if(!appended.has(candidate)){events.push(...candidate);appended.add(candidate)}await opts?.flush?.()},
  }
}

function memberEvent(name: string, phase: "provisioning" | "active" | "failed"): TeamEvent {
  return { type: "team/member", version: 1, teamId: "t", member: { id: `id-${name}`, name, description: "d", provider: "p", context: "fresh", phase } }
}

describe('native candidate admission', () => {
  it('transfers the genuine pre-callback action and finishes unadopted noevent, throw, and validation actions once', async () => {
    const f = await ownedTeamFixture(), begin = f.document.beginAction.bind(f.document)
    const actions: { action: ReturnType<typeof begin>; finished: number; captures: (readonly TeamEvent[])[]; admits: number; reconciles: number }[] = []
    f.document.beginAction = (...args) => {
      const action = begin(...args), finish = action.finish.bind(action), capture = action.captureTeamTransaction.bind(action)
      const record = { action, finished: 0, captures: [] as (readonly TeamEvent[])[], admits: 0, reconciles: 0 }; actions.push(record)
      action.finish = () => { record.finished++; finish() }
      action.captureTeamTransaction = events => {
        record.captures.push(events)
        const fact = capture(events), admit = fact.admit.bind(fact), reconcile = fact.reconcile.bind(fact)
        fact.admit = () => { record.admits++; return admit() }; fact.reconcile = () => { record.reconciles++; return reconcile() }
        return fact
      }
      return action
    }
    const lead = createTeamFacts(f.document, () => tx.drain(), () => {}), tx = createTeamTransact(lead)
    try {
      const events = [memberEvent('owned', 'provisioning')]
      await lead.run(undefined, () => tx.transact(() => {
        expect(actions).toHaveLength(3) // source, retained outer Run, real candidate
        expect(actions[2]!.finished).toBe(0)
        return { events, result: 'original result' }
      }))
      expect(actions[2]!.captures[0]).toBe(events)
      expect([actions[2]!.admits, actions[2]!.reconciles]).toEqual([1, 0])
      expect(actions.map(row => row.finished)).toEqual([1, 1, 1])
      expect(await tx.transact(() => ({ result: 'noevents' }))).toBe('noevents')
      const original = new Error('original pure callback')
      await expect(tx.transact(() => { throw original })).rejects.toBe(original)
      await expect(tx.transact(() => ({ events: [memberEvent('invalid', 'active')], result: true }))).rejects.toThrow(/must start provisioning/)
      expect(actions.slice(3).map(row => [row.finished, row.captures.length])).toEqual([[1, 0], [1, 0], [1, 0]])
      const aborted = new AbortController(); aborted.abort()
      let called = false
      await expect(Promise.resolve().then(() => lead.run(aborted.signal, async () => { called = true }))).rejects.toBeDefined()
      expect(called).toBe(false); expect(actions.at(-1)!.finished).toBe(1)
      await writeFile(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'team-candidate-actions.json'), JSON.stringify({ root: f.root,
        journal: await readFile(join(f.root, 'parent.jsonl'), 'utf8'),
        actions: actions.map(({ finished, captures, admits, reconciles }, index) => ({ identity: index + 1, finished, captures, admits, reconciles })),
      }, null, 2))
    } finally { await lead.close(); await f.coordinator.close() }
  })

  it.each([false, true])('refuses the first queued pure callback after revoke (outer Run=%s)', async outer => {
    const f = await ownedTeamFixture()
    const lead = createTeamFacts(f.document, () => tx.drain(), () => {})
    const tx = createTeamTransact(lead)
    let calls = 0
    const work = () => tx.transact(() => { calls++; return { events: [memberEvent('late', 'provisioning')], result: 'late' } })
    const pending = outer ? lead.run(undefined, work) : work()
    f.document.revokeNewWork()
    try {
      await expect(pending).rejects.toMatchObject({ code: 'FACT_CLOSED' })
      expect(calls).toBe(0)
      await lead.joinRuns(); await lead.close()
      expect(f.document.view.events).toHaveLength(0)
    } finally { await lead.close().catch(() => {}); await f.coordinator.close().catch(() => {}) }
  })

  it('rejects raw inherited expired Run while explicitly independent original work gets its own action', async () => {
    const f = await ownedTeamFixture()
    const lead = createTeamFacts(f.document, () => tx.drain(), () => {})
    const tx = createTeamTransact(lead), release = Promise.withResolvers<void>()
    let stale!: Promise<unknown>, independent!: Promise<unknown>, calls = 0
    try {
      await lead.run(undefined, async () => {
        stale = release.promise.then(() => tx.transact(() => { calls++; return { result: 'stale' } })).catch(error => error)
        independent = release.promise.then(() => lead.withoutRun(() => tx.transact(() => ({ events: [memberEvent('independent', 'provisioning')], result: 'independent' })))).catch(error => error)
      })
      release.resolve()
      expect(await stale).toMatchObject({ code: 'FACT_CLOSED' })
      expect(await independent).toBe('independent'); expect(calls).toBe(0)
      expect(f.document.view.events).toHaveLength(1)
      f.document.revokeNewWork()
      await expect(lead.withoutRun(() => tx.transact(() => { calls++; return { result: 'late' } }))).rejects.toMatchObject({ code: 'FACT_CLOSED' })
      expect(calls).toBe(0)
    } finally { release.resolve(); await lead.close().catch(() => {}); await f.coordinator.close() }
  })

  it('settles the original captured unknown before refusing a new candidate under its expired Run', async () => {
    const f = await ownedTeamFixture(), append = f.backend.appendOwnedBatch!.bind(f.backend)
    const lead = createTeamFacts(f.document, () => tx.drain(), () => {})
    const state = createFoldState(), tx = createTeamTransact(lead, state)
    let key!: BatchKey, writes = 0, calls = 0
    f.backend.appendOwnedBatch = async (...args) => { writes++; await append(...args); key = args[3].key; return { kind: 'unknown', key } }
    const release = Promise.withResolvers<void>()
    let stale!: Promise<unknown>
    try {
      await expect(lead.run(undefined, async () => {
        stale = release.promise.then(() => tx.transact(() => { calls++; return { result: 'forbidden' } })).catch(error => error)
        return tx.transact(() => { calls++; return { events: [memberEvent('original', 'provisioning')], result: true } })
      })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      expect(state.members.size).toBe(0)
      f.document.revokeNewWork(); await f.document.reconcile(key); release.resolve()
      expect(await stale).toMatchObject({ code: 'FACT_CLOSED' })
      await lead.close()
      expect(state.members.get('original')?.phase).toBe('provisioning')
      expect([calls, writes]).toEqual([1, 1])
      console.info('original-candidate-unknown', JSON.stringify({ root: f.root, key, calls, writes }))
      await writeFile(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'team-original-unknown.json'), JSON.stringify({ root: f.root, key, calls, writes,
        journal: await readFile(join(f.root, 'parent.jsonl'), 'utf8'),
      }, null, 2))
    } finally { release.resolve(); await lead.close().catch(() => {}); await f.coordinator.close() }
  })
})

describe("createTeamTransact", () => {
  it("serializes concurrent transactions and commits events", async () => {
    const lead = fakeLead()
    const state = createFoldState()
    const tx = createTeamTransact(lead, state)
    const order: number[] = []
    await Promise.all([
      tx.transact(() => ({ events: [memberEvent("a", "provisioning")], result: order.push(1) })),
      tx.transact(() => ({ events: [memberEvent("b", "provisioning")], result: order.push(2) })),
    ])
    expect(order).toEqual([1, 2])
    expect(lead.events.length).toBe(2)
    expect(state.members.size).toBe(2)
  })

  it("a throwing op commits nothing", async () => {
    const lead = fakeLead()
    const tx = createTeamTransact(lead)
    await expect(tx.transact(() => { throw new Error("boom") })).rejects.toThrow(/boom/)
    expect(lead.events.length).toBe(0)
  })

  it("a mutating fn against live state never corrupts it", async () => {
    const lead = fakeLead()
    const state = createFoldState()
    const tx = createTeamTransact(lead, state)
    await expect(tx.transact((s) => {
      // misbehaving fn: mutates the state it was handed...
      s.members.set("ghost", { id: "g", name: "ghost", description: "d", provider: "p", context: "fresh", phase: "provisioning" })
      // ...and returns a candidate that fails validation (active w/o provisioning)
      return { events: [memberEvent("e", "active")], result: "x" }
    })).rejects.toThrow(/must start provisioning/)
    // live state and log are untouched: the phantom mutation stayed in the clone
    expect(state.members.size).toBe(0)
    expect(lead.events.length).toBe(0)
  })

  it("invalid candidate commits nothing to state or log", async () => {
    const lead = fakeLead()
    const state = createFoldState()
    const tx = createTeamTransact(lead, state)
    await expect(tx.transact(() => ({ events: [memberEvent("n", "active")], result: 1 }))).rejects.toThrow(/must start provisioning/)
    expect(state.members.size).toBe(0)
    expect(lead.events.length).toBe(0)
  })

  it("transact seeds from a provided state", async () => {
    const lead = fakeLead()
    const state = foldTeam([memberEvent("leader1", "provisioning")]).state
    const tx = createTeamTransact(lead, state)
    await expect(tx.transact(() => ({ events: [memberEvent("leader1", "provisioning")], result: 1 }))).rejects.toThrow(/reused/)
    expect(state.members.size).toBe(1)
    expect(lead.events.length).toBe(0)
  })

  it("validates a sequential multi-event candidate in order", async () => {
    const lead = fakeLead()
    const state = createFoldState()
    const tx = createTeamTransact(lead, state)
    await tx.transact(() => ({
      events: [memberEvent("m", "provisioning"), memberEvent("m", "active")],
      result: 1,
    }))
    expect(lead.events.length).toBe(2)
    expect(state.members.get("m")?.phase).toBe("active")
  })

  it("a failed receipt retains the candidate without publishing folded state", async () => {
    const lead = fakeLead({ flush: async () => { throw new Error("disk full") } })
    const state = createFoldState()
    const tx = createTeamTransact(lead, state)
    await expect(tx.transact(() => ({ events: [memberEvent("a", "provisioning")], result: 1 }))).rejects.toThrow(/disk full/)
    // appended + applied BEFORE flush; caller rejects but events are retained
    expect(lead.events.length).toBe(1)
    expect(state.members.size).toBe(0)
  })

  it("the chain survives a flush failure", async () => {
    let calls = 0
    const lead = fakeLead({ flush: async () => { calls++; if (calls === 1) throw new Error("flush boom") } })
    const tx = createTeamTransact(lead)
    await expect(tx.transact(() => ({ events: [memberEvent("a", "provisioning")], result: 1 }))).rejects.toThrow(/flush boom/)
    const r = await tx.transact(() => ({ events: [memberEvent("b", "provisioning")], result: 2 }))
    expect(r).toBe(2)
    expect(lead.events.length).toBe(2)
  })
})
