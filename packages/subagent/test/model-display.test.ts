import { describe, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createAgentRegistry } from "@i-harness/core-agent"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { registerExec } from "@i-harness/exec"
import type { ModelClient } from "@i-harness/llm-seam"
import { createAgentTable } from "../src/agent-table.ts"
import { createJobRegistry } from "../src/jobs.ts"
import { builtinRoles, createRoleRegistry } from "../src/roles.ts"
import { createSubagentTools, type SubagentToolDeps } from "../src/tools.ts"
import { createTaskRegistry, taskDocKey, type TaskProtocolDocument } from "../src/task-protocol.ts"
import { projectAgentTaskDetail, projectAgentTasks } from "../src/projection.ts"
import type { RoleModelSelection, RoleModelState } from "../src/child.ts"

function fixture(overrides: Partial<Pick<SubagentToolDeps, "parentModel" | "roleSelectionFor" | "resolveModel" | "allowSubagentModelSelection">> = {}) {
  const ctx = createContext()
  const execCtx = createContext()
  const table = createAgentTable()
  const jobs = createJobRegistry()
  const roles = createRoleRegistry()
  for (const role of builtinRoles()) roles.register(role)
  const documents = new Map<string, string>()
  const tasks = createTaskRegistry({
    coordinator: { putDocument: async (key: string, value: unknown) => { documents.set(key, JSON.stringify(value)) } } as never,
    stateId: "parent",
  })
  const tools = createSubagentTools({
    table, jobs, roles, tasks,
    parentCtx: ctx, parentRegistry: createToolRegistry(ctx), parentSession: createSession(),
    parentModel: createMockClient([{ role: "assistant", text: "child done" }]),
    resolveModel: async () => ({ status: "unconfigured", reason: "unused" }),
    exec: registerExec(execCtx), agents: createAgentRegistry(),
    ...overrides,
  })
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
  return {
    table, jobs, roles, tasks, tool,
    document: () => JSON.parse(documents.get(taskDocKey("parent"))!) as TaskProtocolDocument,
    async close() {
      for (const path of table.entries().keys()) await tool("close_agent").execute({ target: path }, {})
      await ctx.scope.unmount()
      await execCtx.scope.unmount()
      await tasks.flushPersistence()
    },
  }
}

describe("subagent model display evidence", () => {
  it("omits an undefined model label from the task snapshot without rejecting additive version-1 fields", async () => {
    const seed = createTaskRegistry()
    const task = seed.submit({ identity: { parentSessionId: "parent" }, agentPath: "root/legacy", description: "legacy", prompt: "inspect", agent: "explore", delivery: "tool" })
    seed.terminalize({ taskId: task.id, outcome: "completed", resultText: "done" })
    const putDocument = vi.fn(async (_key: string, _value: unknown) => {})
    const tasks = createTaskRegistry({ coordinator: { putDocument } as never, stateId: "parent" })
    const doc = { formatVersion: 1 as const, tasks: [{ ...task, modelLabel: undefined, extensionEvidence: "retained" }], notifications: [] }
    tasks.restore(doc)
    await tasks.save()
    const saved = putDocument.mock.calls.at(-1)![1] as TaskProtocolDocument
    expect(saved.formatVersion).toBe(1)
    expect(saved.tasks[0]).not.toHaveProperty("modelLabel")
    expect(saved.tasks[0]).toMatchObject({ status: "completed", extensionEvidence: "retained" })
    const restored = createTaskRegistry()
    restored.restore(JSON.parse(JSON.stringify(saved)) as TaskProtocolDocument)
    expect(restored.get(task.id)).toMatchObject({ outcome: "completed", resultText: "done" })
    expect(restored.get(task.id)).not.toHaveProperty("modelLabel")
  })

  it("retains a completed child's resolved label on its task through a serialized document restore after close", async () => {
    let selection: RoleModelSelection = { provider: "deepseek", model: "deepseek-flash" }
    const f = fixture({
      allowSubagentModelSelection: true,
      roleSelectionFor: () => selection,
      resolveModel: async () => ({ status: "ready", binding: { client: createMockClient([{ role: "assistant", text: "child done" }]) } }),
    })
    try {
      const spawned = await f.tool("spawn_agent").execute({ message: "inspect", task_name: "configured", agent_type: "explore", background: false }, { sessionId: "parent" }) as { task_id: string; agent_path: string }
      expect(f.table.get(spawned.agent_path)?.modelLabel).toBe("deepseek:deepseek-flash")
      await f.tool("close_agent").execute({ target: spawned.agent_path }, {})
      expect(f.table.entries().size).toBe(0)
      selection = { provider: "changed", model: "different" }
      await f.tasks.save()
      const doc = f.document()
      expect(doc).toMatchObject({ formatVersion: 1, tasks: [{ id: spawned.task_id, status: "completed", modelLabel: "deepseek:deepseek-flash" }] })

      const restored = createTaskRegistry()
      restored.restore(doc)
      expect(restored.get(spawned.task_id)).toMatchObject({ outcome: "completed", modelLabel: "deepseek:deepseek-flash" })
      const source = { table: createAgentTable(), jobs: createJobRegistry(), roles: f.roles, tasks: restored }
      const row = projectAgentTasks(source)[0]!
      expect(projectAgentTaskDetail(source, row)).toMatchObject({ role: "explore", model: "deepseek:deepseek-flash", result: "child done" })
      expect(projectAgentTaskDetail(source, { ...row, id: spawned.agent_path })?.model).toBe("deepseek:deepseek-flash")
    } finally { await f.close() }
  })

  it("submits before resolution and records the resolved label on the running task before settlement", async () => {
    const resolving = Promise.withResolvers<void>()
    const resolved = Promise.withResolvers<RoleModelState>()
    const finish = Promise.withResolvers<void>()
    const child: ModelClient = { async *stream() { await finish.promise; yield { type: "text/chunk", text: "done" }; yield { type: "end" } } }
    const f = fixture({
      allowSubagentModelSelection: true,
      roleSelectionFor: () => ({ provider: "configured", model: "actual" }),
      resolveModel: async () => { resolving.resolve(); return resolved.promise },
    })
    const pending = f.tool("spawn_agent").execute({ message: "inspect", task_name: "pending", agent_type: "explore" }, { sessionId: "parent" })
    try {
      await resolving.promise
      expect(f.tasks.list()).toHaveLength(1)
      expect(f.tasks.list()[0]).toMatchObject({ status: "accepted" })
      expect(f.tasks.list()[0]).not.toHaveProperty("modelLabel")
      expect(f.table.entries().size).toBe(0)
      await f.tasks.save()
      expect(f.document().tasks[0]).not.toHaveProperty("modelLabel")

      resolved.resolve({ status: "ready", binding: { client: child } })
      const spawned = await pending as { task_id: string }
      expect(f.tasks.get(spawned.task_id)).toMatchObject({ status: "running", modelLabel: "configured:actual" })
      await f.tasks.save()
      expect(f.document().tasks[0]).toMatchObject({ status: "running", modelLabel: "configured:actual" })
    } finally {
      resolved.resolve({ status: "ready", binding: { client: child } })
      finish.resolve()
      await pending
      await f.tasks.wait(f.tasks.list()[0]!.id, 5000)
      await f.close()
    }
  })

  it("an actually unconfigured spawn still completes and displays model not recorded without inventing a label", async () => {
    const resolveModel = vi.fn(async () => ({ status: "unconfigured" as const, reason: "unused" }))
    const f = fixture({ resolveModel })
    try {
      const spawned = await f.tool("spawn_agent").execute({ message: "inspect", task_name: "unconfigured", agent_type: "explore", background: false }, { sessionId: "parent" }) as { agent_path: string; task_id: string }
      expect(resolveModel).not.toHaveBeenCalled()
      expect(f.tasks.get(spawned.task_id)).toMatchObject({ status: "completed", resultText: "child done" })
      expect(f.tasks.get(spawned.task_id)).not.toHaveProperty("modelLabel")
      await f.tool("close_agent").execute({ target: spawned.agent_path }, {})
      await f.tasks.save()
      const doc = f.document()
      expect(doc.tasks[0]).not.toHaveProperty("modelLabel")
      const tasks = createTaskRegistry()
      tasks.restore(doc)
      const source = { table: createAgentTable(), jobs: createJobRegistry(), roles: f.roles, tasks }
      expect(projectAgentTaskDetail(source, projectAgentTasks(source)[0]!)?.model).toBe("model not recorded")
    } finally { await f.close() }
  })
})
