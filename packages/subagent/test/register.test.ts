import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { registerExec } from "@i-harness/exec"
import { registerSubagent } from "../src/index.ts"

/** The seam is required; no role in these cases carries a model, so it is
 * never reached — the cases that exercise a role's model supply their own. */
const resolveModel = async () => ({ status: "unconfigured" as const, reason: "unused" })

describe("registerSubagent", () => {
  it("awaits an in-flight parent notification and its final task document before persistence teardown", async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const saved: unknown[] = []
    const ctx = createContext(), parentReg = createToolRegistry(ctx)
    const mounted = registerSubagent(ctx, parentReg, {
      resolveModel, exec: registerExec(createContext()), parentModel: createMockClient([]), parentSession: createSession(),
      persist: { parentSessionId: "parent", stateId: "parent", coordinator: {
        getDocument: async () => undefined,
        putDocument: async (_key: string, value: unknown) => { saved.push(structuredClone(value)) },
      } as never },
      parentNotify: { admit: async () => { entered.resolve(); await release.promise }, wake: () => {} },
    })
    await mounted.ready
    const task = mounted.tasks.submit({ identity: { parentSessionId: "parent" }, agentPath: "root/helper", description: "helper", prompt: "work", agent: "general", delivery: "parent" })
    mounted.tasks.terminalize({ taskId: task.id, outcome: "completed", resultText: "done" })
    let drained = false
    try {
      const flushing = mounted.flushPersistence().then(() => { drained = true })
      await entered.promise
      expect(drained).toBe(false)
      release.resolve()
      await flushing
      expect(saved.at(-1)).toMatchObject({ notifications: [expect.objectContaining({ status: "woken" })] })
    } finally { release.resolve() }
  })

  it("seeds built-in roles, mounts the 13 tools, and returns the registries", () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const exec = registerExec(createContext())
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const session = createSession()

    const { roles, jobs, table } = registerSubagent(ctx, parentReg, {
      resolveModel,
      exec,
      parentModel: model,
      parentSession: session,
    })

    expect(roles.list().map((r) => r.name).sort()).toEqual(["explore", "general", "research", "worker"])
    expect(parentReg.schemas().map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "spawn_agent", "wait_agent", "list_agents", "send_message", "interrupt_agent",
        "followup_task", "close_agent", "resume_agent", "job_output", "job_list", "job_kill",
        "get_task_output", "stop_task",
      ]),
    )
    expect(typeof jobs.registerJob).toBe("function")
    expect(typeof table.get).toBe("function")
  })

  it("returns a live task registry (durable records behind the mount)", () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const exec = registerExec(createContext())
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const session = createSession()

    const { tasks } = registerSubagent(ctx, parentReg, {
      resolveModel, exec, parentModel: model, parentSession: session,
    })

    expect(typeof tasks.submit).toBe("function")
    expect(typeof tasks.terminalize).toBe("function")
    expect(tasks.list()).toEqual([])
  })

  it("is idempotent when called twice on the same registry", () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const exec = registerExec(createContext())
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const session = createSession()
    registerSubagent(ctx, parentReg, { resolveModel, exec, parentModel: model, parentSession: session })
    expect(() => registerSubagent(ctx, parentReg, { resolveModel, exec, parentModel: model, parentSession: session })).not.toThrow()
  })
})
