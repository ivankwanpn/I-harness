import { describe, expect, it } from "vitest"
import { foldTeam, applyTeamEvent } from "../src/index.ts"
import type { TeamEvent } from "../src/index.ts"

const base: TeamEvent = {
  type: "team/member", version: 1, teamId: "lead-1",
  member: { id: "child-1", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" },
}

describe("foldTeam", () => {
  it("folds sequential member/queue/delivered events into state", () => {
    const events: TeamEvent[] = [
      base,
      { ...base, member: { ...base.member, phase: "active" } },
      { type: "team/message/queued", version: 1, teamId: "lead-1", message: { id: "msg-1", senderId: "lead-1", senderName: "lead", targetId: "child-1", delivery: "wakeup", content: "hi" } },
      { type: "team/message/delivered", version: 1, teamId: "lead-1", messageId: "msg-1", targetId: "child-1" },
    ]
    const { state } = foldTeam(events)
    expect(state.members.get("helper")?.phase).toBe("active")
    expect(state.queued.get("child-1")?.length).toBe(1)
    expect(state.delivered.has("msg-1")).toBe(true)
  })

  it("incremental: watermark skips already-folded events", () => {
    const { watermark } = foldTeam([base])
    expect(watermark).toBe(1)
    const { state: s2 } = foldTeam([base, { ...base, member: { ...base.member, phase: "active" } }], { watermark })
    expect(s2.members.get("helper")?.phase).toBe("active")
  })

  it("rejects invalid member transitions", () => {
    const state = foldTeam([]).state
    expect(() => applyTeamEvent(state, { ...base, member: { ...base.member, phase: "active" } })).toThrow()
  })

  it("rejects non-monotonic task revisions and duplicate queue", () => {
    const state = foldTeam([]).state
    const task: TeamEvent = { type: "team/task", version: 1, teamId: "lead-1", task: { id: "task-u1", revision: 2, subject: "s", description: "d", status: "pending", blockedBy: [], writeScopes: [] } }
    expect(() => applyTeamEvent(state, task)).toThrow() // revision must start at 1
  })

  it("rejects malformed team events (structure validation)", () => {
    const state = foldTeam([]).state
    // member missing name
    expect(() => applyTeamEvent(state, { type: "team/member", version: 1, teamId: "t", member: { id: "c", description: "d", provider: "p", context: "fresh", phase: "provisioning" } } as unknown as TeamEvent)).toThrow(/invalid team\/member event/)
    // queued missing targetId
    expect(() => applyTeamEvent(state, { type: "team/message/queued", version: 1, teamId: "t", message: { id: "m", senderId: "l", senderName: "lead", delivery: "wakeup", content: "x" } } as unknown as TeamEvent)).toThrow(/invalid team\/message\/queued event/)
  })

  it("rejects unknown team/* types and version !== 1", () => {
    const state = foldTeam([]).state
    expect(() => applyTeamEvent(state, { type: "team/bogus", version: 1, teamId: "t" } as unknown as TeamEvent)).toThrow(/invalid team\/bogus event/)
    expect(() => applyTeamEvent(state, { ...base, version: 2 } as unknown as TeamEvent)).toThrow(/invalid team\/member event/)
  })

  it("rejects member identity changes on transitions", () => {
    const state = foldTeam([]).state
    applyTeamEvent(state, base)
    expect(() => applyTeamEvent(state, { ...base, member: { ...base.member, phase: "active", id: "child-2" } })).toThrow(/identity immutable/)
  })

  it("skips non-team events in fold and applyTeamEvent", () => {
    const { state, watermark } = foldTeam([
      base,
      { ...base, member: { ...base.member, phase: "active" } },
      { type: "turn/start", seq: 0 } as unknown as TeamEvent,
    ])
    expect(watermark).toBe(3)
    expect(state.members.get("helper")?.phase).toBe("active")
    const s2 = foldTeam([]).state
    expect(() => applyTeamEvent(s2, { type: "turn/start", seq: 0 } as unknown as TeamEvent)).not.toThrow()
  })
})
