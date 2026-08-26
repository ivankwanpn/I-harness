// TDD: task board — CAS revisions, DAG readiness, tombstones, advisory write
// scopes (M19 Task 7).
//
// Ruling 10(c): every transact fn is PURE-READ (inspects state, returns
// { events, result }; never mutates), so these tests exercise the REAL
// createTeamTransact over a shared seeded createFoldState() — a fake transact
// (e.g. async (fn) => fn(state).result) would mask double-apply / mutation
// bugs, because a mutating fn would then corrupt the live state directly.
//
// Controller correction: the brief's reassign test used expectedRevision 6 on a
// task whose revision after claim is 2 — the stale check would throw first, so
// this test uses expectedRevision 2 to actually reach the reassign authority
// check.
import { describe, expect, it } from "vitest"
import { createTaskBoard, createFoldState, createTeamTransact, normalizeWriteScopes } from "../src/index.ts"
import type { TeamCaller, TeamEvent, TaskBoardDeps } from "../src/index.ts"

const LEAD: TeamCaller = { id: "lead-1", name: "lead", role: "lead" }
const HELPER: TeamCaller = { id: "child-helper", name: "helper", role: "teammate" }

function makeBoard(overrides?: Partial<TaskBoardDeps>) {
  const events: TeamEvent[] = []
  const state = createFoldState()
  const lead = { append: (e: TeamEvent) => events.push(e), flush: async () => {} }
  const board = createTaskBoard({
    teamId: "lead-1",
    state,
    // REAL transact over the shared live state — never a mock.
    transact: createTeamTransact(lead, state),
    ...overrides,
  })
  return { board, state, events }
}

describe("TaskBoard", () => {
  it("creates a pending task with revision 1 and a uuid id", async () => {
    const { board, state, events } = makeBoard()
    const t = await board.createTask(LEAD, { subject: "s", description: "d" })
    expect(t.id).toMatch(/^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(t.revision).toBe(1)
    expect(t.status).toBe("pending")
    expect(t.blockedBy).toEqual([])
    expect(t.ready).toBe(true)
    expect(t.writeScopeWarnings).toEqual([])
    // committed through the real transact: state + event log
    expect(state.tasks.get(t.id)?.revision).toBe(1)
    expect(events).toHaveLength(1)
  })

  it("CAS: stale expectedRevision throws TASK_STALE_REVISION", async () => {
    const { board, state } = makeBoard()
    const t = await board.createTask(LEAD, { subject: "s", description: "d" })
    await expect(board.updateTask(LEAD, { taskId: t.id, expectedRevision: 0, action: "claim" })).rejects.toThrow(/stale/i)
    // rejected: nothing commits
    expect(state.tasks.get(t.id)?.revision).toBe(1)
    expect(state.tasks.get(t.id)?.status).toBe("pending")
  })

  it("claim requires readiness: incomplete blockers throw TASK_BLOCKED", async () => {
    const { board, state } = makeBoard()
    const blocker = await board.createTask(LEAD, { subject: "blocker", description: "d" })
    const t = await board.createTask(LEAD, { subject: "s", description: "d", blockedBy: [blocker.id] })
    expect(t.ready).toBe(false)
    await expect(board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "claim" })).rejects.toThrow(/blocked|ready/i)
    expect(state.tasks.get(t.id)?.status).toBe("pending")
  })

  it("a task becomes ready once its blockers complete", async () => {
    const { board } = makeBoard()
    const blocker = await board.createTask(LEAD, { subject: "blocker", description: "d" })
    const t = await board.createTask(LEAD, { subject: "s", description: "d", blockedBy: [blocker.id] })
    expect((await board.getTask(LEAD, t.id)).ready).toBe(false)
    await board.updateTask(LEAD, { taskId: blocker.id, expectedRevision: 1, action: "claim" })
    await board.updateTask(LEAD, { taskId: blocker.id, expectedRevision: 2, action: "complete" })
    expect((await board.getTask(LEAD, t.id)).ready).toBe(true)
    const claimed = await board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "claim" })
    expect(claimed.status).toBe("in_progress")
  })

  it("only Lead can reassign (corrected: expectedRevision 2 after claim)", async () => {
    const { board, state } = makeBoard()
    const t = await board.createTask(LEAD, { subject: "s", description: "d" })
    const claimed = await board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "claim" })
    expect(claimed.revision).toBe(2)
    await expect(
      board.updateTask(HELPER, { taskId: t.id, expectedRevision: 2, action: "reassign", owner: "helper" }),
    ).rejects.toThrow(/lead|reassign/i)
    // the failed reassign left the task untouched
    expect(state.tasks.get(t.id)?.ownerId).toBe("lead-1")
    expect(state.tasks.get(t.id)?.revision).toBe(2)
  })

  it("delete with a non-deleted dependent throws TASK_HAS_DEPENDENTS", async () => {
    const { board, state } = makeBoard()
    const t = await board.createTask(LEAD, { subject: "s", description: "d" })
    const dep = await board.createTask(LEAD, { subject: "dep", description: "d", blockedBy: [t.id] })
    await expect(board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "delete" })).rejects.toThrow(/dependents/i)
    expect(state.tasks.get(t.id)?.status).toBe("pending")
    void dep
  })

  it("owner completes a claimed task: revision +1, status completed", async () => {
    const { board, state } = makeBoard()
    const t = await board.createTask(LEAD, { subject: "s", description: "d" })
    await board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "claim" })
    const done = await board.updateTask(LEAD, { taskId: t.id, expectedRevision: 2, action: "complete" })
    expect(done.status).toBe("completed")
    expect(done.revision).toBe(3)
    expect(state.tasks.get(t.id)?.status).toBe("completed")
  })

  it("claim requires pending: a completed unowned task cannot be claimed", async () => {
    const { board, state } = makeBoard()
    const t = await board.createTask(LEAD, { subject: "s", description: "d" })
    // Lead completes an unowned pending task (authorized); it stays unowned.
    const done = await board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "complete" })
    expect(done.status).toBe("completed")
    expect(done.ownerId).toBeUndefined()
    // claim on a completed task would bypass the reopen path — rejected.
    await expect(board.updateTask(HELPER, { taskId: t.id, expectedRevision: 2, action: "claim" })).rejects.toThrow(/invalid_transition|claim/i)
    expect(state.tasks.get(t.id)?.status).toBe("completed")
    expect(state.tasks.get(t.id)?.ownerId).toBeUndefined()
  })

  it("create rejects empty or whitespace-only subject/description", async () => {
    const { board, state } = makeBoard()
    await expect(board.createTask(LEAD, { subject: "", description: "d" })).rejects.toThrow(/invalid_argument/i)
    await expect(board.createTask(LEAD, { subject: "  ", description: "d" })).rejects.toThrow(/invalid_argument/i)
    await expect(board.createTask(LEAD, { subject: "s", description: "" })).rejects.toThrow(/invalid_argument/i)
    expect(state.tasks.size).toBe(0)
  })

  it("edit rejects empty subject/description but keeps existing values when omitted", async () => {
    const { board, state } = makeBoard()
    const t = await board.createTask(LEAD, { subject: "s", description: "d" })
    await expect(board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "edit", description: "" })).rejects.toThrow(/invalid_argument/i)
    await expect(board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "edit", subject: " " })).rejects.toThrow(/invalid_argument/i)
    // rejection commits nothing; task unchanged at revision 1
    expect(state.tasks.get(t.id)?.subject).toBe("s")
    expect(state.tasks.get(t.id)?.revision).toBe(1)
    // omitted fields keep existing values; trimmed values are persisted
    const edited = await board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "edit", subject: " s2 ", description: " d2 " })
    expect(edited.subject).toBe("s2")
    expect(edited.description).toBe("d2")
    expect(state.tasks.get(t.id)?.subject).toBe("s2")
  })

  it("tombstone: deleted task hidden from listTasks but returned by getTask", async () => {
    const { board } = makeBoard()
    const t = await board.createTask(LEAD, { subject: "s", description: "d" })
    const gone = await board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "delete" })
    expect(gone.status).toBe("deleted")
    expect(gone.revision).toBe(2)
    const listed = await board.listTasks(LEAD)
    expect(listed.tasks.map((x) => x.id)).not.toContain(t.id)
    expect((await board.getTask(LEAD, t.id)).status).toBe("deleted")
  })

  it("maxTasks counts only non-deleted tasks", async () => {
    const { board } = makeBoard({ maxTasks: 1 })
    const t = await board.createTask(LEAD, { subject: "s", description: "d" })
    await board.updateTask(LEAD, { taskId: t.id, expectedRevision: 1, action: "delete" })
    // the tombstone no longer counts against the limit
    const b = await board.createTask(LEAD, { subject: "s2", description: "d" })
    expect(b.revision).toBe(1)
    await expect(board.createTask(LEAD, { subject: "s3", description: "d" })).rejects.toThrow(/limit/i)
  })

  it("set_dependencies rejects self, duplicates, and transitive cycles", async () => {
    const { board } = makeBoard()
    const a = await board.createTask(LEAD, { subject: "a", description: "d" })
    const b = await board.createTask(LEAD, { subject: "b", description: "d" })
    // self-dependency is a cycle
    await expect(board.updateTask(LEAD, { taskId: a.id, expectedRevision: 1, action: "set_dependencies", blockedBy: [a.id] })).rejects.toThrow(/cycle/i)
    // duplicate entries are invalid
    await expect(board.updateTask(LEAD, { taskId: a.id, expectedRevision: 1, action: "set_dependencies", blockedBy: [b.id, b.id] })).rejects.toThrow(/invalid_argument/i)
    // transitive cycle: b waits on a, then a cannot wait on b
    await board.updateTask(LEAD, { taskId: b.id, expectedRevision: 1, action: "set_dependencies", blockedBy: [a.id] })
    await expect(board.updateTask(LEAD, { taskId: a.id, expectedRevision: 1, action: "set_dependencies", blockedBy: [b.id] })).rejects.toThrow(/cycle/i)
  })

  it("normalizeWriteScopes normalizes separators and rejects invalid scopes", async () => {
    expect(normalizeWriteScopes(["./src//", "a\\b", "docs/"])).toEqual(["src", "a/b", "docs"])
    for (const bad of ["/abs", "../x", "a/../b", "C:/x", "C:", ""]) {
      expect(() => normalizeWriteScopes([bad])).toThrow(/write scope/i)
    }
    const { board } = makeBoard()
    await expect(board.createTask(LEAD, { subject: "s", description: "d", writeScopes: ["/abs"] })).rejects.toThrow(/write_scope/i)
  })

  it("writeScopeWarnings flag overlap with other in_progress tasks", async () => {
    const { board } = makeBoard()
    const a = await board.createTask(LEAD, { subject: "a", description: "d", writeScopes: ["src"] })
    await board.updateTask(LEAD, { taskId: a.id, expectedRevision: 1, action: "claim" })
    const b = await board.createTask(LEAD, { subject: "b", description: "d", writeScopes: ["src"] })
    const bView = (await board.listTasks(LEAD)).tasks.find((x) => x.id === b.id)!
    expect(bView.writeScopeWarnings.some((w) => w.includes(a.id))).toBe(true)
    // once b is in_progress too, a sees the overlap as well (advisory both ways)
    await board.updateTask(LEAD, { taskId: b.id, expectedRevision: 1, action: "claim" })
    const aView = (await board.listTasks(LEAD)).tasks.find((x) => x.id === a.id)!
    expect(aView.writeScopeWarnings.some((w) => w.includes(b.id))).toBe(true)
  })
})
