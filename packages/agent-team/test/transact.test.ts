import { describe, expect, it } from "vitest"
import { createTeamTransact, createFoldState, foldTeam } from "../src/index.ts"
import type { TeamEvent } from "../src/index.ts"

function fakeLead(opts?: { flush?: () => Promise<void> }) {
  const events: TeamEvent[] = []
  let cb: (() => void) | undefined
  return {
    events,
    append: (e: TeamEvent) => { events.push(e); cb?.() },
    flush: opts?.flush ?? (async () => {}),
    onCommit: (fn: () => void) => { cb = fn },
  }
}

function memberEvent(name: string, phase: "provisioning" | "active" | "failed"): TeamEvent {
  return { type: "team/member", version: 1, teamId: "t", member: { id: `id-${name}`, name, description: "d", provider: "p", context: "fresh", phase } }
}

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

  it("a flush failure rejects but retains applied events (at-least-once)", async () => {
    const lead = fakeLead({ flush: async () => { throw new Error("disk full") } })
    const state = createFoldState()
    const tx = createTeamTransact(lead, state)
    await expect(tx.transact(() => ({ events: [memberEvent("a", "provisioning")], result: 1 }))).rejects.toThrow(/disk full/)
    // appended + applied BEFORE flush; caller rejects but events are retained
    expect(lead.events.length).toBe(1)
    expect(state.members.size).toBe(1)
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
