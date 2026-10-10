import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createSessionAssembly } from "@i-harness/session-executor"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDesktopGoalTools } from "../src/workflow.ts"

it("a real root model turn receives an unknown tool result while its independent write succeeds", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ih-batch-unknown-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(workspace, "sessions")))
  await coordinator.create({ sessionId: "root" })
  let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
  try {
    assembly = await createSessionAssembly({ workspace, sessionId: "root", coordinator, modelPolicy: "test-mock", approveAll: true,
      mockScript: [
        { role: "assistant", toolCalls: [
          { name: "parent_only_tool", args: {} },
          { name: "write", args: { path: "independent.txt", text: "known sibling completed" } },
        ] },
        { role: "assistant", text: "The unknown name failed; the authorized write completed." },
      ],
    })
    const result = await assembly.agent.run("Try the two independent calls")
    expect(result.finalText).toContain("authorized write completed")
    expect(await readFile(join(workspace, "independent.txt"), "utf8")).toBe("known sibling completed")
    await coordinator.flush("root")
    const durable = (await coordinator.load("root")).session.events
    expect(durable.filter(event => event.type === "tool/result")).toMatchObject([
      { name: "parent_only_tool", isError: true, output: { error: "unknown tool: parent_only_tool", code: "TOOL_FAILED" } },
      { name: "write", output: { ok: true } },
    ])
    expect(durable.at(-1)?.type).toBe("turn/end")
  } finally { await assembly?.dispose(); await coordinator.close(); await rm(workspace, { recursive: true, force: true }) }
})

it("root assembly writes an independent file after an inactive goal_complete in the same model batch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ih-batch-goal-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(workspace, "sessions")))
  await coordinator.create({ sessionId: "root" })
  let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
  try {
    assembly = await createSessionAssembly({ workspace, sessionId: "root", coordinator,
      modelPolicy: "test-mock", approveAll: true, maxParallelToolCalls: 2,
      additionalTools: createDesktopGoalTools(() => assembly?.session, () => {}),
      mockScript: [
        { role: "assistant", toolCalls: [
          { name: "goal_complete", args: { id: "inactive", revision: 1 } },
          { name: "write", args: { path: join(workspace, "sibling_test.txt"), text: "independent write" } },
        ] },
        { role: "assistant", text: "done" },
      ],
    })
    await assembly.agent.run("run the batch")
    expect(await readFile(join(workspace, "sibling_test.txt"), "utf8")).toBe("independent write")
    const results = assembly.session.events.filter((event) => event.type === "tool/result")
    expect(results).toMatchObject([
      { name: "goal_complete", isError: true, output: { error: "Goal is not active", code: "TOOL_FAILED" } },
      { name: "write", output: { ok: true } },
    ])
    await coordinator.flush("root")
    const durable = (await coordinator.load("root")).session.events
    expect(durable.filter((event) => event.type === "tool/result").map((event) => event.callId)).toEqual(results.map((event) => event.callId))
    const lastResult = durable.findLastIndex((event) => event.type === "tool/result")
    const stepEnd = durable.findIndex((event, index) => index > lastResult && event.type === "step/end")
    expect(stepEnd).toBe(lastResult + 1)
    expect(durable.at(-1)?.type).toBe("turn/end")
  } finally {
    await assembly?.dispose()
    await coordinator.close()
    await rm(workspace, { recursive: true, force: true })
  }
}, 30_000)

it("root assembly attempts close_agent and job_kill after schedule_delete fails in their model batch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ih-batch-schedule-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(workspace, "sessions")))
  await coordinator.create({ sessionId: "root" })
  let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
  try {
    assembly = await createSessionAssembly({ workspace, sessionId: "root", coordinator,
      modelPolicy: "test-mock", approveAll: true, maxParallelToolCalls: 3,
      mockScript: [
        { role: "assistant", toolCalls: [
          { name: "schedule_delete", args: { id: "schedule-1" } },
          { name: "close_agent", args: { target: "root/no-agent" } },
          { name: "job_kill", args: { job_id: "no-job" } },
        ] },
        { role: "assistant", text: "done" },
      ],
    })
    await assembly.agent.run("run the cleanup batch")
    const results = assembly.session.events.filter((event) => event.type === "tool/result")
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ name: "schedule_delete", output: { error: expect.stringContaining("schedule-1"), code: "TOOL_FAILED" } })
    expect(results[1]).toMatchObject({ name: "close_agent", output: { error: expect.stringContaining("unknown subagent"), code: "TOOL_FAILED" } })
    expect(results[2]).toMatchObject({ name: "job_kill", output: { error: expect.stringContaining("unknown job"), code: "TOOL_FAILED" } })
    expect(assembly.session.events.filter((event) => event.type === "tool/dispatch")).toHaveLength(3)
  } finally {
    await assembly?.dispose()
    await coordinator.close()
    await rm(workspace, { recursive: true, force: true })
  }
}, 30_000)
