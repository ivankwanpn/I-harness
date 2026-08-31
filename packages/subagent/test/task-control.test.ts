import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgentRegistry } from "@i-harness/core-agent"
import { createProviderRegistry } from "@i-harness/provider"
import { createExecService } from "@i-harness/exec"
import type { ModelClient } from "@i-harness/llm-seam"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { cancelSubtree, createSubagentTools, type SubagentToolDeps } from "../src/tools.ts"
import { createTaskRegistry, TaskConcurrencyLimitError } from "../src/task-protocol.ts"

function setupWith(maxConcurrency?: number) {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
  const session = createSession()
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  const tasks = createTaskRegistry({ maxConcurrency })
  const exec = createExecService()
  const model = createMockClient([{ role: "assistant", text: "done" }])
  const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers: createProviderRegistry(), exec, agents: createAgentRegistry(), tasks })
  return { all, tasks }
}

describe("M26-D3 concurrency permit (tool-level)", () => {
  it("a pre-occupied permit rejects a new spawn; settlement frees it", async () => {
    const { all, tasks } = setupWith(1)
    // Manually occupy the single permit with an accepted record — deliberately
    // NOT through spawn (a mock child settles within one tick, which would race
    // the count). This is a deterministic occupied-permit setup.
    tasks.submit({ identity: { parentSessionId: "s1", callEventSeq: 0 }, agentPath: "root/occupy", description: "occupy", prompt: "p", agent: "general", delivery: "tool" })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    await expect(spawn.execute({ message: "blocked", task_name: "b" }, { sessionId: "s1", callEventSeq: 1 })).rejects.toThrow(TaskConcurrencyLimitError)
    tasks.terminalize({ taskId: "task-1", outcome: "cancelled", error: "freed" })
    await expect(spawn.execute({ message: "ok", task_name: "c" }, { sessionId: "s1", callEventSeq: 2 })).resolves.toMatchObject({ task_id: "task-2" })
  }, 15_000)
})

describe("M26-D3 cancelTree", () => {
  it("cancels the target + descendant records; aborts and awaits quiescence of the live table subtree", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const model = createMockClient([{ role: "assistant", text: "child done" }])
    const tasks = createTaskRegistry()
    // 重建兩層鏈：task-1 (root/a) + task-2 (root/a/b)
    tasks.restore({
      formatVersion: 1,
      tasks: [
        { id: "task-1", parentSessionId: "s-1", callEventSeq: 1, agentPath: "root/a", description: "a", prompt: "p", agent: "general", delivery: "parent", status: "accepted", timeCreated: 1 },
        { id: "task-2", parentSessionId: "s-2", callEventSeq: 2, childSessionId: "child-2", agentPath: "root/a/b", description: "b", prompt: "p", agent: "general", delivery: "parent", status: "running", timeCreated: 2 },
      ],
      notifications: [],
    })
    const deps: SubagentToolDeps = {
      table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx,
      parentModel: model, providers: createProviderRegistry(), exec: createExecService(),
      agents: createAgentRegistry(), tasks,
    }
    // 活體 entry（供 quiescence）：running stub —— cancelSubtree 會 abort 其 controller
    table.add("root/a/b", { path: "root/a/b", status: "running", session: createSession(), controller: new AbortController(), mailbox: [] })
    const result = await cancelSubtree(deps, "task-1", "scope changed")
    expect(result).toEqual({ taskIds: ["task-1", "task-2"], cancelled: 2 })
    expect(tasks.get("task-1")).toMatchObject({ outcome: "cancelled", error: "scope changed" })
    expect(tasks.get("task-2")).toMatchObject({ outcome: "cancelled" })
    expect(table.get("root/a/b")!.controller.signal.aborted).toBe(true)
    // parent-delivery 的已取消任務入 outbox（cancelTree 路徑，同一 doc 寫）
    expect(tasks.notifications().map((n) => n.state)).toEqual(["cancelled", "cancelled"])
  }, 15_000)

  it("misses an unknown id (identity error) and no-ops for an already-terminal root", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const session = createSession()
    const tasks = createTaskRegistry()
    const deps: SubagentToolDeps = {
      table: createAgentTable(), jobs: createJobRegistry(), roles: createRoleRegistry(),
      parentRegistry: parentReg, parentSession: session, parentCtx: ctx,
      parentModel: createMockClient([]), providers: createProviderRegistry(),
      exec: createExecService(), agents: createAgentRegistry(), tasks,
    }
    await expect(cancelSubtree(deps, "task-99")).rejects.toThrow(/unknown task/)
    tasks.restore({
      formatVersion: 1,
      tasks: [{ id: "task-1", parentSessionId: "s1", callEventSeq: 1, agentPath: "root/x", description: "x", prompt: "p", agent: "general", delivery: "tool", status: "completed", outcome: "completed", timeCreated: 1 }],
      notifications: [],
    })
    expect(await cancelSubtree(deps, "task-1")).toEqual({ taskIds: [], cancelled: 0 })
  }, 15_000)

  it("close_agent terminalizes its task record as cancelled (not left running)", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    // slow child: close must run while the initial turn is still in flight —
    // ADAPTATION (plan T11 Step 1 vs an instant mock): a fast mock settles
    // before close executes and the CAS would keep the record completed,
    // making the assertion flaky instead of deterministic.
    const slowModel: ModelClient = {
      async *stream() {
        yield { type: "text/chunk", text: "working" }
        await new Promise((r) => setTimeout(r, 1500))
        yield { type: "end" }
      },
    }
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: slowModel, providers: createProviderRegistry(), exec: createExecService(), agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const close = all.find((t) => t.name === "close_agent")!
    await spawn.execute({ message: "go", task_name: "h" }, { sessionId: "s1", callEventSeq: 1 })
    await close.execute({ target: "root/h" }, {})
    expect(tasks.get("task-1")!.outcome).toBe("cancelled")
  }, 15_000)
})

// Tool<..., unknown> execute returns unknown — cast the small output views the
// assertions read (legacy test convention).
type TaskOutputView = { task_id: string; status: string; outcome?: string; agent_path: string; description: string; resultText?: string; error?: string; time_created: number }
type StopTaskView = { outcome: string; cancelled: number; task_ids: string[] }

describe("M26-D4 get_task_output", () => {
  it("returns durable views for 1..20 owned task ids; bounded wait; non-owned identical failure", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const model = createMockClient([{ role: "assistant", text: "child done" }])
    const tasks = createTaskRegistry()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers: createProviderRegistry(), exec: createExecService(), agents: createAgentRegistry(), tasks })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const get = all.find((t) => t.name === "get_task_output")!
    await spawn.execute({ message: "go", task_name: "h" }, { sessionId: "s1", callEventSeq: 1 })
    await tasks.wait("task-1", 10_000)
    const out = await get.execute({ task_ids: ["task-1"] }, {}) as { tasks: TaskOutputView[] }
    expect(out.tasks).toHaveLength(1)
    expect(out.tasks[0]).toMatchObject({ task_id: "task-1", status: "completed", agent_path: "root/h" })
    expect(out.tasks[0]!.resultText).toBe("child done")
    // non-owned → identical failure (no oracle)
    await expect(get.execute({ task_ids: ["task-999"] }, {})).rejects.toThrow("unknown task: task-999")
    await expect(get.execute({ task_ids: ["bash-1"] }, {})).rejects.toThrow("unknown task: bash-1")
    await expect(get.execute({ task_ids: ["not-a-task"] }, {})).rejects.toThrow("unknown task: not-a-task")
    // bounds: 0 ids and 21 ids fail identically-shaped validation errors
    await expect(get.execute({ task_ids: [] }, {})).rejects.toThrow(/between 1 and 20/)
    await expect(get.execute({ task_ids: Array.from({ length: 21 }, (_, i) => `task-${i}`) }, {})).rejects.toThrow(/between 1 and 20/)
    // wait mode clamps [100, 600000]
    const waitOut = await get.execute({ task_ids: ["task-1"], wait: true, timeout_ms: 5000 }, {}) as { tasks: TaskOutputView[] }
    expect(waitOut.tasks[0]!.status).toBe("completed")
  }, 15_000)
})

describe("M26-D4 stop_task", () => {
  it("stop_task cancels the task tree via cancelSubtree; unknown id fails identically", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    const session = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const model = createMockClient([{ role: "assistant", text: "done" }])
    const tasks = createTaskRegistry()
    // Deterministic setup: restore an accepted record (never via spawn — a mock
    // child settles within one tick, which would race the cancel). The live
    // table entry pins the abort + quiescence path with a deferred chain.
    tasks.restore({
      formatVersion: 1,
      tasks: [
        { id: "task-1", parentSessionId: "s1", callEventSeq: 2, agentPath: "root/h", description: "h", prompt: "p", agent: "general", delivery: "parent", status: "running", timeCreated: 1 },
      ],
      notifications: [],
    })
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers: createProviderRegistry(), exec: createExecService(), agents: createAgentRegistry(), tasks })
    const stop = all.find((t) => t.name === "stop_task")!
    // ADAPTATION (plan T13 Step 1): the plan created a deferred gate, awaited
    // stop.execute (which awaits quiescence of that very chain) and resolved
    // the gate AFTER the await — a guaranteed deadlock. Resolve the gate
    // BEFORE the call: the entry still pins a followupChain for the
    // quiescence wait, just an already-settled one.
    const gate = Promise.withResolvers<void>()
    gate.resolve()
    table.add("root/h", { path: "root/h", status: "running", session: createSession(), controller: new AbortController(), mailbox: [], followupChain: gate.promise })
    const out = await stop.execute({ task_id: "task-1", reason: "scope changed" }, {}) as StopTaskView
    expect(out).toEqual({ outcome: "cancellation-requested", cancelled: 1, task_ids: ["task-1"] })
    expect(tasks.get("task-1")!.outcome).toBe("cancelled")
    expect(table.get("root/h")!.controller.signal.aborted).toBe(true)
    // idempotent second call
    expect(await stop.execute({ task_id: "task-1" }, {}) as StopTaskView).toEqual({ outcome: "already-finished", cancelled: 0, task_ids: [] })
    await expect(stop.execute({ task_id: "task-9" }, {})).rejects.toThrow("unknown task: task-9")
  }, 15_000)
})
