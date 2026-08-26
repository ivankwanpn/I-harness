// TDD: mailbox — durable queued->delivered with recovery (M19 Task 6).
//
// Ruling 10(c): the mailbox's transact fns are PURE-READ (inspect state, return
// events; never mutate), so these tests exercise the REAL transact over a
// seeded createFoldState() — a fake transact such as `async (fn) => fn(state)`
// would mask mutation/double-apply bugs.
import { describe, expect, it } from "vitest"
import { createMailbox, createFoldState, createTeamTransact } from "../src/index.ts"
import type { TeamCaller, TeamEvent, MailboxDeps, TeamFoldState } from "../src/index.ts"

const LEAD: TeamCaller = { id: "lead-1", name: "lead", role: "lead" }
const HELPER: TeamCaller = { id: "child-1", name: "helper", role: "teammate" }

function makeMailbox(overrides?: Partial<MailboxDeps> & { state?: TeamFoldState }) {
  const events: TeamEvent[] = []
  const state = overrides?.state ?? createFoldState()
  if (!overrides?.state) {
    // baseline folded state: the target member exists (as after spawn/activate)
    state.members.set("helper", { id: "child-1", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active" })
  }
  const lead = { append: (e: TeamEvent) => events.push(e), flush: async () => {} }
  const mailbox = createMailbox({
    teamId: "lead-1",
    state,
    // REAL transact over the shared seeded state — never a mock.
    transact: createTeamTransact(lead, state),
    deliver: async (_targetId: string, _messageId: string, _content: string, _delivery: "quiet" | "wakeup", _signal?: AbortSignal) => true,
    memberStatus: (_id: string) => "idle" as const,
    maxPendingMessagesPerMember: 64,
    maxMessageBytes: 65_536,
    ...overrides,
  })
  return { mailbox, state, events }
}

describe("TeamMailbox", () => {
  it("queues, delivers, then acknowledges delivered", async () => {
    const { mailbox, state, events } = makeMailbox()
    const r = await mailbox.sendMessage(LEAD, "helper", "hello", "wakeup")
    expect(r.status).toBe("accepted")
    expect(r.messageId).toMatch(/^msg-/)
    expect(state.delivered.has(r.messageId)).toBe(true)
    // the queued entry remains (delivered is marked, not pruned) — idempotent replays
    expect(state.queued.get("child-1")?.some((m) => m.id === r.messageId)).toBe(true)
    // both events appended: queued first, then the delivered ACK (only after deliver resolved true)
    expect(events.map((e) => e.type)).toEqual(["team/message/queued", "team/message/delivered"])
  })

  it("keeps the message queued when delivery fails (no ack appended)", async () => {
    const { mailbox, state, events } = makeMailbox({ deliver: async () => false })
    const r = await mailbox.sendMessage(LEAD, "helper", "hello", "quiet")
    expect(r.status).toBe("queued")
    expect(state.queued.get("child-1")?.length).toBe(1)
    expect(state.delivered.size).toBe(0)
    expect(events.map((e) => e.type)).toEqual(["team/message/queued"]) // no delivered ack
    // recovery keeps trying, but a still-failing delivery leaves it queued
    await mailbox.recoverRoot()
    expect(state.delivered.size).toBe(0)
    expect(state.queued.get("child-1")?.length).toBe(1)
    expect(events.map((e) => e.type)).toEqual(["team/message/queued"])
  })

  it("recovers queued messages FIFO once delivery succeeds", async () => {
    let attempts = 0
    const { mailbox, state, events } = makeMailbox({ deliver: async () => { attempts++; return attempts >= 3 } })
    // two sends fail at delivery time (attempts 1, 2) -> both stay queued, in order
    const a = await mailbox.sendMessage(LEAD, "helper", "first", "wakeup")
    const b = await mailbox.sendMessage(LEAD, "helper", "second", "wakeup")
    expect(a.status).toBe("queued")
    expect(b.status).toBe("queued")
    expect(state.queued.get("child-1")?.map((m) => m.id)).toEqual([a.messageId, b.messageId])
    await mailbox.recoverRoot() // attempts 3, 4 -> both delivered
    expect(state.delivered.has(a.messageId)).toBe(true)
    expect(state.delivered.has(b.messageId)).toBe(true)
    const deliveredIds = events.filter((e) => e.type === "team/message/delivered").map((e) => e.messageId)
    expect(deliveredIds).toEqual([a.messageId, b.messageId]) // FIFO order per target
    expect(events.map((e) => e.type).filter((t) => t.startsWith("team/message/"))).toEqual([
      "team/message/queued", "team/message/queued", "team/message/delivered", "team/message/delivered",
    ])
  })

  it("recoverRoot skips quiet messages targeted at inactive members", async () => {
    let attempts = 0
    const { mailbox, state, events } = makeMailbox({
      memberStatus: () => "inactive" as const,
      deliver: async () => { attempts++; return false },
    })
    const r = await mailbox.sendMessage(LEAD, "helper", "note", "quiet")
    expect(r.status).toBe("queued")
    expect(attempts).toBe(1)
    await mailbox.recoverRoot()
    // quiet never wakes an inactive member: deliver is not even attempted
    expect(attempts).toBe(1)
    expect(state.delivered.size).toBe(0)
    expect(state.queued.get("child-1")?.length).toBe(1)
    expect(events.map((e) => e.type)).toEqual(["team/message/queued"])
    void r
  })

  it("recoverRoot delivers quiet messages to idle members (only inactive is skipped)", async () => {
    let attempts = 0
    const { mailbox, state, events } = makeMailbox({
      memberStatus: () => "idle" as const,
      deliver: async () => { attempts++; return attempts >= 2 },
    })
    const r = await mailbox.sendMessage(LEAD, "helper", "note", "quiet")
    expect(r.status).toBe("queued")
    expect(attempts).toBe(1)
    await mailbox.recoverRoot()
    expect(attempts).toBe(2) // quiet + idle is delivered; only inactive is skipped
    expect(state.delivered.has(r.messageId)).toBe(true)
    expect(events.filter((e) => e.type === "team/message/delivered").map((e) => e.messageId)).toEqual([r.messageId])
  })

  it("recoverRoot still delivers wakeup messages to inactive members", async () => {
    let attempts = 0
    const { mailbox, state } = makeMailbox({
      memberStatus: () => "inactive" as const,
      deliver: async () => { attempts++; return attempts >= 2 },
    })
    const r = await mailbox.sendMessage(LEAD, "helper", "urgent", "wakeup")
    expect(r.status).toBe("queued")
    expect(attempts).toBe(1)
    await mailbox.recoverRoot()
    expect(attempts).toBe(2) // wakeup is attempted even though the target is inactive
    expect(state.delivered.has(r.messageId)).toBe(true)
  })

  it("resolves the target 'lead' to the team id and delivers to it", async () => {
    const { mailbox, state, events } = makeMailbox()
    const r = await mailbox.sendMessage(HELPER, "lead", "report", "wakeup")
    expect(r.status).toBe("accepted")
    expect(state.queued.get("lead-1")?.some((m) => m.id === r.messageId)).toBe(true)
    expect(state.delivered.has(r.messageId)).toBe(true)
    expect(events.map((e) => e.type)).toEqual(["team/message/queued", "team/message/delivered"])
  })

  it("rejects self-message and unknown target", async () => {
    const { mailbox, state, events } = makeMailbox()
    await expect(mailbox.sendMessage(HELPER, "helper", "x", "quiet")).rejects.toThrow(/TEAM_SELF_MESSAGE|self/i)
    await expect(mailbox.sendMessage(LEAD, "lead", "x", "quiet")).rejects.toThrow(/TEAM_SELF_MESSAGE|self/i)
    await expect(mailbox.sendMessage(LEAD, "nobody", "x", "quiet")).rejects.toThrow(/TEAM_MEMBER_NOT_FOUND|unknown/i)
    expect(state.queued.size).toBe(0)
    expect(events).toHaveLength(0)
  })

  it("rejects a non-member teammate caller", async () => {
    const { mailbox, state, events } = makeMailbox()
    const ghost: TeamCaller = { id: "child-99", name: "ghost", role: "teammate" }
    await expect(mailbox.sendMessage(ghost, "helper", "x", "quiet")).rejects.toThrow(/TEAM_NOT_MEMBER|not a team member/i)
    expect(state.queued.size).toBe(0)
    expect(events).toHaveLength(0)
  })

  it("rejects when the target mailbox is full", async () => {
    const { mailbox, state, events } = makeMailbox({ maxPendingMessagesPerMember: 2, deliver: async () => false })
    const a = await mailbox.sendMessage(LEAD, "helper", "one", "quiet")
    const b = await mailbox.sendMessage(LEAD, "helper", "two", "quiet")
    expect(a.status).toBe("queued")
    expect(b.status).toBe("queued")
    await expect(mailbox.sendMessage(LEAD, "helper", "three", "quiet")).rejects.toThrow(/TEAM_MAILBOX_FULL|full/i)
    expect(state.queued.get("child-1")?.length).toBe(2) // nothing extra was queued
    expect(events.filter((e) => e.type === "team/message/queued")).toHaveLength(2)
  })

  it("enforces maxPending atomically under concurrent sends (in-fn re-check, not only the live pre-check)", async () => {
    const { mailbox, state, events } = makeMailbox({ maxPendingMessagesPerMember: 1, deliver: async () => false })
    // Both sends start synchronously with 0 pending, so BOTH pass the live
    // pre-check before either commits — the race the pre-check alone misses.
    // The transact chain serializes; the second send's fn re-checks against the
    // clone (which already contains the first send's committed message) and
    // throws MAILBOX_FULL.
    const results = await Promise.allSettled([
      mailbox.sendMessage(LEAD, "helper", "one", "quiet"),
      mailbox.sendMessage(LEAD, "helper", "two", "quiet"),
    ])
    expect(results[0].status).toBe("fulfilled")
    expect((results[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe("queued")
    expect(results[1].status).toBe("rejected")
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/TEAM_MAILBOX_FULL|full/i)
    // exactly ONE message entered the queue — the limit held atomically
    expect(state.queued.get("child-1")?.length).toBe(1)
    expect(events.filter((e) => e.type === "team/message/queued")).toHaveLength(1)
  })

  it("rejects oversized messages before queueing", async () => {
    const { mailbox, state, events } = makeMailbox({ maxMessageBytes: 16 })
    await expect(mailbox.sendMessage(LEAD, "helper", "x".repeat(64), "quiet")).rejects.toThrow(/TEAM_MESSAGE_TOO_LARGE|exceeds/i)
    expect(state.queued.size).toBe(0)
    expect(events).toHaveLength(0)
  })

  it("byte limit uses spec framing with message id and 'from'", async () => {
    // Old framing `Team message <lead>:\n` + 10 content bytes ~= 31 total —
    // PASSES maxMessageBytes 50. Spec framing `Team message <msg-<uuid>> from
    // <lead>:\n` + 10 content bytes exceeds 50 — must REJECT. Proves the limit
    // measures the spec framing (message id + from), not a short form.
    const { mailbox, state, events } = makeMailbox({ maxMessageBytes: 50 })
    await expect(mailbox.sendMessage(LEAD, "helper", "x".repeat(10), "quiet")).rejects.toThrow(/TEAM_MESSAGE_TOO_LARGE|exceeds/i)
    expect(state.queued.size).toBe(0)
    expect(events).toHaveLength(0)
  })
})
