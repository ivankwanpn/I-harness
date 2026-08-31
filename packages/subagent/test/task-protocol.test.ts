import { describe, expect, it } from "vitest"
import { createTaskRegistry, taskDocKey, notificationMessageId, TaskIdentityConflictError, TaskConcurrencyLimitError, type TaskSubmissionInput } from "../src/task-protocol.ts"

function fakePersist(records: unknown[] = []) {
  const saved: unknown[] = []
  return {
    saved,
    coord: {
      putDocument: async (_k: string, data: unknown) => { saved.push(data) },
      getDocument: async () => records[0],
    } as never,
  }
}

describe("task protocol store", () => {
  it("taskDocKey namespaces by stateId", () => {
    expect(taskDocKey("sess-main")).toBe("task-sess-main")
  })

  it("submit creates an accepted record; exact retry adopts; conflicting reuse fails", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const identity = { parentSessionId: "s-main", callEventSeq: 7, toolCallId: "call_4" }
    // ADAPTATION (M26-D1, plan T3 Step 1): an unannotated const widens
    // `delivery: "parent"` to `string`, which TS rejects against
    // TaskSubmissionInput — annotate the input instead.
    const input: TaskSubmissionInput = { identity, agentPath: "root/helper", description: "helper", prompt: "probe the repo", agent: "general", delivery: "parent" }
    const first = tasks.submit(input)
    expect(first.id).toBe("task-1")
    expect(first.status).toBe("accepted")
    expect(first.timeCreated).toBeGreaterThan(0)
    // exact retry → adopted (same object, no second record)
    const again = tasks.submit(input)
    expect(again).toBe(first)
    expect(tasks.list()).toHaveLength(1)
    // conflicting reuse (different prompt) → TaskIdentityConflictError
    expect(() => tasks.submit({ ...input, prompt: "something else" })).toThrow(TaskIdentityConflictError)
  })

  it("an anonymous identity (no seq/callId) always mints a new task", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const a = tasks.submit({ identity: { parentSessionId: "" }, agentPath: "root/a", description: "a", prompt: "p", agent: "general", delivery: "tool" })
    const b = tasks.submit({ identity: { parentSessionId: "" }, agentPath: "root/b", description: "b", prompt: "p", agent: "general", delivery: "tool" })
    expect(a.id).not.toBe(b.id)
  })

  it("claim transitions accepted→running and sets childSessionId; terminalize is CAS (non-terminal only)", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const rec = tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "tool" })
    expect(tasks.claim(rec.id, "child-1")).toBe(true)
    expect(tasks.get(rec.id)!.status).toBe("running")
    expect(tasks.get(rec.id)!.childSessionId).toBe("child-1")
    // re-claim: already running → false
    expect(tasks.claim(rec.id)).toBe(false)
    expect(tasks.terminalize({ taskId: rec.id, outcome: "completed", resultText: "done" })).toBe(true)
    expect(tasks.get(rec.id)!.outcome).toBe("completed")
    expect(tasks.get(rec.id)!.status).toBe("completed")
    expect(tasks.get(rec.id)!.timeCompleted).toBeGreaterThan(0)
    // CAS: terminalized once — a second terminalize is a no-op
    expect(tasks.terminalize({ taskId: rec.id, outcome: "error", error: "late" })).toBe(false)
    expect(tasks.get(rec.id)!.outcome).toBe("completed")
  })

  it("terminalize enqueues a durable notification for parent-delivery tasks (same record state)", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const rec = tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 2 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: rec.id, outcome: "completed", resultText: "ok" })
    const notifs = tasks.notifications()
    expect(notifs).toHaveLength(1)
    expect(notifs[0]).toMatchObject({ submissionId: rec.id, parentSessionId: "s-main", status: "pending", attempts: 0, state: "completed" })
    expect(notifs[0]!.id).toMatch(/^notif-/)
    expect(notifs[0]!.messageId).toBe(notificationMessageId(rec.id))
    expect(notifs[0]!.messageId).toMatch(/^msg_task_[0-9a-f]{32}$/)
    // tool-delivery tasks never notify
    const rec2 = tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 3 }, agentPath: "root/h2", description: "h2", prompt: "p", agent: "general", delivery: "tool" })
    tasks.terminalize({ taskId: rec2.id, outcome: "error", error: "boom" })
    expect(tasks.notifications()).toHaveLength(1)
  })

  it("wait resolves with the terminal record or undefined on timeout", async () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never })
    const rec = tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 4 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "tool" })
    const pending = tasks.wait(rec.id, 30)
    tasks.terminalize({ taskId: rec.id, outcome: "completed", resultText: "ok" })
    const settled = await pending
    expect(settled?.outcome).toBe("completed")
    expect(await tasks.wait(rec.id, 10)).toBeDefined()
    expect(await tasks.wait("task-999", 10)).toBeUndefined()
  })

  it("save persists formatVersion-1 doc with tasks + notifications; restore round-trips", async () => {
    // ADAPTATION (M26-D1, plan T3 Step 1 vs Step 3): the plan's fixture omitted
    // `stateId` — but save() per Step 3 requires coordinator + stateId (the doc
    // key IS task:<stateId>; a stateId-less registry is in-memory only, e.g.
    // the empty registry T4 mounts). Passing stateId exercises the real path.
    const p = fakePersist()
    let tasks = createTaskRegistry({ coordinator: p.coord as never, stateId: "sess-main" })
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 5 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    await tasks.save()
    const doc = p.saved[0] as { formatVersion: number; tasks: unknown[]; notifications: unknown[] }
    expect(doc.formatVersion).toBe(1)
    expect(doc.tasks).toHaveLength(1)
    const fresh = createTaskRegistry({ coordinator: p.coord as never })
    fresh.restore(doc as never)
    expect(fresh.get("task-1")?.prompt).toBe("p")
    expect(fresh.notifications()).toHaveLength(0)
  })

  it("maxConcurrency fails closed on submit (non-terminal count)", () => {
    const { coord } = fakePersist()
    const tasks = createTaskRegistry({ coordinator: coord as never, maxConcurrency: 1 })
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 6 }, agentPath: "root/a", description: "a", prompt: "p", agent: "general", delivery: "tool" })
    expect(() =>
      tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 7 }, agentPath: "root/b", description: "b", prompt: "p", agent: "general", delivery: "tool" }),
    ).toThrow(TaskConcurrencyLimitError)
  })
})
