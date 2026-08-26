// TDD: roster — named roster + provisioning lifecycle (M19 Task 5).
//
// Ruling 10(c): the roster's transact fns are PURE-READ (inspect state, return
// events; never mutate), so these tests exercise the REAL transact over a
// seeded createFoldState() — a fake transact would mask double-apply /
// mutation bugs.
import { describe, expect, it } from "vitest"
import { createRoster, createFoldState, createTeamTransact } from "../src/index.ts"
import type { TeamCaller, TeamEvent, RosterDeps } from "../src/index.ts"

const LEAD: TeamCaller = { id: "lead-1", name: "lead", role: "lead" }
const TEAMMATE: TeamCaller = { id: "child-helper", name: "helper", role: "teammate" }
const OPTS = { description: "d", prompt: "do x", context: "fresh" as const }

function makeRoster(overrides?: Partial<RosterDeps>) {
  const events: TeamEvent[] = []
  const state = createFoldState()
  const lead = { append: (e: TeamEvent) => events.push(e), flush: async () => {} }
  const roster = createRoster({
    teamId: "lead-1",
    state,
    // REAL transact over the shared seeded state — never a mock.
    transact: createTeamTransact(lead, state),
    spawnChild: async (name: string, _prompt: string, _context: "fresh" | "fork") => ({ path: `lead/${name}`, jobId: "job-1", sessionId: `child-${name}` }),
    childSessionHoldsPrompt: async () => true,
    interruptChild: async () => "running",
    closeChild: async () => {},
    ...overrides,
  })
  return { roster, state, events }
}

describe("TeamRoster", () => {
  it("spawnTeammate provisions then activates a member", async () => {
    const { roster, state, events } = makeRoster()
    const member = await roster.spawnTeammate(LEAD, "helper", OPTS)
    // member is committed as active in the shared state
    expect(state.members.has("helper")).toBe(true)
    expect(state.members.get("helper")?.phase).toBe("active")
    // both phases were appended to the log, in order: provisioning -> active
    const memberEvents = events.filter((e) => e.type === "team/member")
    expect(memberEvents.map((e) => e.member.phase)).toEqual(["provisioning", "active"])
    expect(member.role).toBe("teammate")
  })

  it("fails provisioning when the child never holds the prompt", async () => {
    const { roster, state } = makeRoster({ childSessionHoldsPrompt: async () => false })
    await expect(roster.spawnTeammate(LEAD, "helper", OPTS)).rejects.toThrow(/durably held|failed/i)
    expect(state.members.get("helper")?.phase).toBe("failed")
    expect(roster.listMembers().find((m) => m.name === "helper")?.status).toBe("failed")
  })

  it("rejects name reuse", async () => {
    const { roster, state } = makeRoster()
    await roster.spawnTeammate(LEAD, "helper", OPTS)
    await expect(roster.spawnTeammate(LEAD, "helper", OPTS)).rejects.toThrow(/TAKEN|reused/i)
    expect(state.members.size).toBe(1)
    expect(state.members.get("helper")?.phase).toBe("active")
  })

  it("enforces maxMembers", async () => {
    const { roster, state } = makeRoster({ maxMembers: 1 })
    await roster.spawnTeammate(LEAD, "helper", OPTS)
    await expect(roster.spawnTeammate(LEAD, "helper2", OPTS)).rejects.toThrow(/LIMIT|reached/i)
    expect(state.members.size).toBe(1)
  })

  it("rejects a non-Lead caller spawning", async () => {
    const { roster, state, events } = makeRoster()
    await expect(roster.spawnTeammate(TEAMMATE, "helper", OPTS)).rejects.toThrow(/LEAD_REQUIRED/i)
    expect(state.members.size).toBe(0)
    expect(events).toHaveLength(0)
  })

  it("interrupt is Lead-only and returns the previous status", async () => {
    const { roster, state, events } = makeRoster()
    await roster.spawnTeammate(LEAD, "helper", OPTS)
    const before = events.length
    await expect(roster.interrupt(TEAMMATE, "helper")).rejects.toThrow(/LEAD_REQUIRED/i)
    expect(events.length).toBe(before) // no event emitted for the rejected interrupt
    const r = await roster.interrupt(LEAD, "helper")
    expect(r.previousStatus).toBe("running")
    expect(state.members.get("helper")?.phase).toBe("active") // interrupt is not a phase transition
  })

  it("maps live child status for active members via memberStatus", async () => {
    const statuses = new Map<string, string>()
    const { roster, state } = makeRoster({ memberStatus: (id) => statuses.get(id) ?? "unknown" })
    await roster.spawnTeammate(LEAD, "helper", OPTS)
    const id = state.members.get("helper")!.id
    expect(roster.listMembers().find((m) => m.name === "helper")?.status).toBe("inactive") // unknown -> inactive
    statuses.set(id, "running")
    expect(roster.listMembers().find((m) => m.name === "helper")?.status).toBe("running")
    statuses.set(id, "waiting")
    expect(roster.listMembers().find((m) => m.name === "helper")?.status).toBe("idle")
  })
})

// Spec §8.3: reconcileProvisioning — recovery after a crash mid-spawn leaves a
// member in "provisioning"; on mount it is settled by durability probe:
// durable child → active, else → failed. Idempotent for already-settled members.
describe("reconcileProvisioning", () => {
  // Seed a shared state containing a provisioning member exactly like a crash
  // would leave it: provisioning event folded into the live state via the real
  // transact (event is in the log AND the state). member.phase === "provisioning"
  // and `child-helper` is the (simulated) durable child session id.
  function seedProvisioning(overrides?: Partial<RosterDeps>) {
    const { roster, state, events } = makeRoster(overrides)
    const tx = createTeamTransact(
      { append: (e: TeamEvent) => events.push(e), flush: async () => {} },
      state,
    )
    return new Promise<{ roster: ReturnType<typeof createRoster>; state: typeof state; events: TeamEvent[]; memberId: string }>((resolve) => {
      tx.transact(() => ({
        events: [{ type: "team/member", version: 1, teamId: "lead-1", member: { id: "child-helper", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } }],
        result: undefined,
      })).then(() => resolve({ roster, state, events, memberId: "child-helper" }))
    })
  }

  it("activates a provisioning member when the child session is durable", async () => {
    const { roster, state, events, memberId } = await seedProvisioning({ childSessionIsDurable: async (id) => id === memberId })
    await roster.reconcileProvisioning()
    expect(state.members.get("helper")?.phase).toBe("active")
    const memberEvents = events.filter((e) => e.type === "team/member")
    expect(memberEvents.map((e) => e.member.phase)).toEqual(["provisioning", "active"])
  })

  it("fails a provisioning member when the child session is not durable", async () => {
    const { roster, state, events } = await seedProvisioning({ childSessionIsDurable: async () => false })
    await roster.reconcileProvisioning()
    expect(state.members.get("helper")?.phase).toBe("failed")
    expect(state.members.get("helper")?.error).toMatch(/not durable/i)
    const memberEvents = events.filter((e) => e.type === "team/member")
    expect(memberEvents.map((e) => e.member.phase)).toEqual(["provisioning", "failed"])
  })

  it("leaves already-settled members untouched (idempotent; no conflict)", async () => {
    const { roster, state, events } = await seedProvisioning({ childSessionIsDurable: async () => true })
    await roster.reconcileProvisioning()
    const before = events.filter((e) => e.type === "team/member").length
    await expect(roster.reconcileProvisioning()).resolves.toBeUndefined() // second reconcile: no pending members
    expect(state.members.get("helper")?.phase).toBe("active")
    expect(events.filter((e) => e.type === "team/member").length).toBe(before) // nothing appended
  })

  it("loses the creator-vs-reconcile race cleanly (guard fires, no throw, no double-settle)", async () => {
    const { state, events } = await seedProvisioning()
    // Simulate a concurrent creator settling the member (provisioning -> active)
    // DURING the durability probe: the probe races the settle then reports durable.
    let settled = false
    const settleTx = createTeamTransact({ append: (e: TeamEvent) => events.push(e), flush: async () => {} }, state)
    const probe = async (id: string) => {
      if (!settled) {
        await settleTx.transact(() => ({
          events: [{ type: "team/member", version: 1, teamId: "lead-1", member: { id, name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active" } }],
          result: undefined,
        }))
        settled = true
      }
      return true // the child IS durable, but the member was settled in the meantime
    }
    const { roster: r } = makeRoster({ state, transact: createTeamTransact({ append: (e: TeamEvent) => events.push(e), flush: async () => {} }, state), childSessionIsDurable: probe })
    // reconcile filtered "helper" as pending before the probe, so the probe's
    // settle lands FIRST; reconcile's transact fn then sees phase !==
    // "provisioning" -> PROVISIONING_CONFLICT fires internally and is swallowed.
    // reconcile must NOT throw and must not double-settle (one settle only).
    await expect(r.reconcileProvisioning()).resolves.toBeUndefined()
    expect(state.members.get("helper")?.phase).toBe("active")
    const memberEvents = events.filter((e) => e.type === "team/member")
    expect(memberEvents.map((e) => e.member.phase)).toEqual(["provisioning", "active"]) // exactly one settle
  })

  it("reconciles a mix: durable → active, not durable → failed", async () => {
    const { roster, state, events } = await seedProvisioning({ childSessionIsDurable: async () => false })
    // add a second provisioning member that IS durable
    await createTeamTransact({ append: (e: TeamEvent) => events.push(e), flush: async () => {} }, state).transact(() => ({
      events: [{ type: "team/member", version: 1, teamId: "lead-1", member: { id: "child-helper2", name: "helper2", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } }],
      result: undefined,
    }))
    const { roster: r2 } = makeRoster({
      state,
      transact: createTeamTransact({ append: (e: TeamEvent) => events.push(e), flush: async () => {} }, state),
      childSessionIsDurable: async (id) => id === "child-helper2",
      childSessionHoldsPrompt: async () => true,
    })
    await r2.reconcileProvisioning()
    expect(state.members.get("helper")?.phase).toBe("failed")
    expect(state.members.get("helper2")?.phase).toBe("active")
    expect(roster.listMembers().find((m) => m.name === "helper2")?.status).toBe("inactive") // active, no live status -> inactive
  })
})
