import { describe, expect, it } from "vitest"
import { createTeamTransact } from "../src/index.ts"
import type { TeamEvent } from "../src/index.ts"

function fakeLead() {
  const events: TeamEvent[] = []
  let cb: (() => void) | undefined
  return {
    events,
    append: (e: TeamEvent) => { events.push(e); cb?.() },
    flush: async () => {},
    onCommit: (fn: () => void) => { cb = fn },
  }
}

describe("createTeamTransact", () => {
  it("serializes concurrent transactions and commits events", async () => {
    const lead = fakeLead()
    const tx = createTeamTransact(lead)
    const order: number[] = []
    await Promise.all([
      tx.transact(() => ({ events: [{ type: "team/member", version: 1, teamId: "t", member: { id: "c1", name: "a", description: "d", provider: "p", context: "fresh", phase: "provisioning" } }], result: order.push(1) })),
      tx.transact(() => ({ events: [{ type: "team/member", version: 1, teamId: "t", member: { id: "c2", name: "b", description: "d", provider: "p", context: "fresh", phase: "provisioning" } }], result: order.push(2) })),
    ])
    expect(order).toEqual([1, 2])
    expect(lead.events.length).toBe(2)
  })

  it("a throwing op commits nothing", async () => {
    const lead = fakeLead()
    const tx = createTeamTransact(lead)
    await expect(tx.transact(() => { throw new Error("boom") })).rejects.toThrow(/boom/)
    expect(lead.events.length).toBe(0)
  })
})
