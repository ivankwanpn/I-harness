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
