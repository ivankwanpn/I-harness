import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createProviderRegistry } from "@i-harness/provider"
import { createExecService } from "@i-harness/exec"
import { registerSubagent } from "../src/index.ts"

describe("registerSubagent", () => {
  it("seeds built-in roles, mounts the 11 tools, and returns the registries", () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const providers = createProviderRegistry()
    const exec = createExecService()
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const session = createSession()

    const { roles, jobs, table } = registerSubagent(ctx, parentReg, {
      providers,
      exec,
      parentModel: model,
      parentSession: session,
    })

    expect(roles.list().map((r) => r.name).sort()).toEqual(["explore", "general", "research", "worker"])
    expect(parentReg.schemas().map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "spawn_agent", "wait_agent", "list_agents", "send_message", "interrupt_agent",
        "followup_task", "close_agent", "resume_agent", "job_output", "job_list", "job_kill",
      ]),
    )
    expect(typeof jobs.registerJob).toBe("function")
    expect(typeof table.get).toBe("function")
  })

  it("is idempotent when called twice on the same registry", () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const providers = createProviderRegistry()
    const exec = createExecService()
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const session = createSession()
    registerSubagent(ctx, parentReg, { providers, exec, parentModel: model, parentSession: session })
    expect(() => registerSubagent(ctx, parentReg, { providers, exec, parentModel: model, parentSession: session })).not.toThrow()
  })
})
