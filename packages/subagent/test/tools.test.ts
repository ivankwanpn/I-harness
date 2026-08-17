import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createProviderRegistry } from "@i-harness/provider"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { createSubagentTools } from "../src/tools.ts"

function setup() {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
  const session = createSession()
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  const providers = createProviderRegistry()
  const model = createMockClient([{ role: "assistant", text: "child done" }])
  const tools = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
  return { ctx, parentReg, session, jobs, table, roles, providers, model, tools }
}

describe("subagent tools", () => {
  it("registers spawn_agent, wait_agent, list_agents", () => {
    const { tools } = setup()
    const names = tools.map((t) => t.name).sort()
    expect(names).toContain("spawn_agent")
    expect(names).toContain("wait_agent")
    expect(names).toContain("list_agents")
  })

  it("spawn_agent returns a job id; list_agents shows it; wait_agent observes completion", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const list = all.find((t) => t.name === "list_agents")!
    const wait = all.find((t) => t.name === "wait_agent")!
    const spawnOut = await spawn.execute({ message: "do it", task_name: "helper" }, {})
    expect((spawnOut as { job_id: string }).job_id).toMatch(/^subagent-\d+$/)
    expect((spawnOut as { agent_path: string }).agent_path).toBe("root/helper")
    const listed = await list.execute({ path_prefix: "root/" }, {})
    expect((listed as { agents: { path: string }[] }).agents.map((a) => a.path)).toEqual(["root/helper"])
    const waitOut = await wait.execute({ timeout_ms: 5000 }, {})
    expect((waitOut as { timed_out: boolean }).timed_out).toBe(false)
  }, 10_000)

  it("spawn_agent with unknown agent_type errors", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    await expect(spawn.execute({ message: "x", task_name: "h", agent_type: "nope" }, {})).rejects.toThrow(/unknown role/i)
  })
})

describe("subagent control tools", () => {
  it("send_message queues into the child mailbox", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const send = all.find((t) => t.name === "send_message")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const out = await send.execute({ target: "root/helper", message: "extra" }, {})
    expect(out).toEqual({ queued: true })
    expect(table.get("root/helper")!.mailbox).toContain("extra")
  }, 10_000)

  it("close_agent aborts and removes the child", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const close = all.find((t) => t.name === "close_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    expect(table.get("root/helper")).toBeDefined()
    const out = await close.execute({ target: "root/helper" }, {})
    expect((out as { previous_status: string }).previous_status).toBe("running")
    expect(table.get("root/helper")).toBeUndefined()
  }, 10_000)

  it("interrupt_agent aborts the controller but keeps the agent", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const interrupt = all.find((t) => t.name === "interrupt_agent")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const entry = table.get("root/helper")!
    const out = await interrupt.execute({ target: "root/helper" }, {})
    expect((out as { previous_status: string }).previous_status).toBe("running")
    expect(table.get("root/helper")).toBeDefined()
    expect(entry.controller.signal.aborted).toBe(true)
  }, 10_000)

  it("resume_agent re-adds a fresh child entry", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const resume = all.find((t) => t.name === "resume_agent")!
    const out = await resume.execute({ target: "root/helper" }, {})
    expect((out as { resumed: boolean }).resumed).toBe(true)
    expect(table.get("root/helper")!.status).toBe("running")
  })

  it("followup_task queues and marks delivered", async () => {
    const { ctx, table, jobs, roles, parentReg, session, providers, model } = setup()
    const all = createSubagentTools({ table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx, parentModel: model, providers })
    const spawn = all.find((t) => t.name === "spawn_agent")!
    const follow = all.find((t) => t.name === "followup_task")!
    await spawn.execute({ message: "do it", task_name: "helper" }, {})
    const out = await follow.execute({ target: "root/helper", message: "more" }, {})
    expect((out as { delivered: boolean }).delivered).toBe(true)
    expect(table.get("root/helper")!.mailbox).toContain("more")
  }, 10_000)
})
