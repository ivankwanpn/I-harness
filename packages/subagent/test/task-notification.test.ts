import { describe, expect, it, vi } from "vitest"
import { createTaskRegistry } from "../src/task-protocol.ts"
import { createNotificationDrain, renderTaskNotification } from "../src/task-notification.ts"

describe("task notification outbox", () => {
  it("drain admits pending rows (renderPayload → admit → delivered → wake → woken)", async () => {
    const tasks = createTaskRegistry()
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "helper", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: "task-1", outcome: "completed", resultText: "ok done" })
    const admits: { sessionId: string; text: string; description: string }[] = []
    const wake = vi.fn()
    const drain = createNotificationDrain({ tasks, admit: { admit: async (a) => { admits.push(a) }, wake } })
    const n = await drain.drain()
    expect(n).toBe(1)
    expect(admits).toHaveLength(1)
    expect(admits[0]).toMatchObject({ sessionId: "s-main", description: "helper" })
    expect(admits[0]!.text).toContain("task-1")
    expect(admits[0]!.text).toContain("completed")
    expect(wake).toHaveBeenCalledWith("s-main")
    const notif = tasks.notifications()[0]!
    expect(notif.status).toBe("woken")
    expect(notif.attempts).toBe(1)
    expect(notif.timeWoken).toBeGreaterThan(0)
    await expect(drain.drain()).resolves.toBe(0) // idempotent — no re-admit
  })

  it("a failed admit errors the row (status error) and is retried on the next drain", async () => {
    const tasks = createTaskRegistry()
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: "task-1", outcome: "error", error: "bad turn" })
    let calls = 0
    const drain = createNotificationDrain({ tasks, admit: { admit: async () => { calls += 1; if (calls === 1) throw new Error("queue down"); await Promise.resolve() }, wake: () => {} } })
    await drain.drain()
    expect(tasks.notifications()[0]!.status).toBe("error")
    expect(tasks.notifications()[0]!.error).toBe("queue down")
    await drain.drain() // retry succeeds
    expect(tasks.notifications()[0]!.status).toBe("woken")
    expect(tasks.notifications()[0]!.attempts).toBe(2)
  })

  it("suppresses delivery when the parent session chain is cancelled (D3 hook)", async () => {
    const tasks = createTaskRegistry()
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: "task-1", outcome: "completed", resultText: "x" })
    const wake = vi.fn()
    const drain = createNotificationDrain({ tasks, admit: { admit: async () => {}, wake }, isSessionCancelled: (sid) => sid === "s-main" })
    const n = await drain.drain()
    expect(n).toBe(0)
    expect(tasks.notifications()[0]!.status).toBe("suppressed")
    expect(wake).not.toHaveBeenCalled()
  })

  it("absent admit (no A-plan yet) keeps rows pending — durable-only delivery", async () => {
    const tasks = createTaskRegistry()
    tasks.submit({ identity: { parentSessionId: "s-main", callEventSeq: 1 }, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent" })
    tasks.terminalize({ taskId: "task-1", outcome: "completed", resultText: "x" })
    const drain = createNotificationDrain({ tasks, admit: undefined })
    expect(await drain.drain()).toBe(0)
    expect(tasks.notifications()[0]!.status).toBe("pending")
  })

  it("renderTaskNotification renders the opencode payload shape", () => {
    const text = renderTaskNotification("completed", "task-1", "helper", "ok done")
    expect(text).toBe("<task id=\"task-1\" state=\"completed\">\n<summary>helper</summary>\n<task_result>\nok done\n</task_result>\n</task>")
  })
})
