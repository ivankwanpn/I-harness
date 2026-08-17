import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, type SessionEvent } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { forkTurns } from "../src/fork.ts"
import { spawnChild } from "../src/child.ts"
import { createProviderRegistry } from "@i-harness/provider"

function makeTool(name: string): Tool {
  return { name, description: "", inputSchema: {}, execute: async () => ({}) }
}

describe("fork.ts", () => {
  it("forkTurns returns the last N turn blocks", () => {
    const events: SessionEvent[] = []
    const push = (type: string, extra: Record<string, unknown> = {}) => events.push({ type, ...extra } as SessionEvent)
    push("turn/start"); push("user/message", { text: "a" }); push("assistant/message", { text: "A" }); push("turn/end")
    push("turn/start"); push("user/message", { text: "b" }); push("assistant/message", { text: "B" }); push("turn/end")
    const last = forkTurns(events, 1)
    expect(last.some((e) => (e as { text?: string }).text === "b")).toBe(true)
    expect(last.some((e) => (e as { text?: string }).text === "a")).toBe(false)
  })
})

describe("spawnChild", () => {
  it("spawns a background child with a role and resolves completion", async () => {
    const parentCtx = createContext()
    const parentReg = createToolRegistry(parentCtx)
    parentReg.register(makeTool("read"))
    const parentSession = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const providers = createProviderRegistry()
    const model = createMockClient([{ role: "assistant", text: "child done" }])

    const { path, jobId } = spawnChild({
      taskName: "helper",
      message: "do the thing",
      parentPath: "root",
      parentRegistry: parentReg,
      parentSession,
      parentCtx,
      role: roles.get("general")!,
      parentModel: model,
      providers,
      jobs,
      table,
    })
    expect(path).toBe("root/helper")
    expect(jobId).toMatch(/^subagent-\d+$/)
    expect(table.get("root/helper")!.status).toBe("running")
    await new Promise((r) => setTimeout(r, 150))
    expect(table.get("root/helper")!.status).toBe("completed")
    expect(jobs.read(jobId).status).toBe("completed")
  }, 10_000)
})
