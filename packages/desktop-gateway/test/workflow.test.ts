import { expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { append } from "@i-harness/core-session"
import { foldGoal } from "@i-harness/goal"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import { forkSession } from "@i-harness/session-persistence"
import { createDesktopWorkflow, createDesktopGoalTools } from "../src/workflow.ts"

it("persists Goal/Plan controls and job history, rejecting stale Goal edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-workflow-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s" })
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  const workflow = createDesktopWorkflow(coordinator, service)
  try {
    const created = await workflow.mutate("s", { action: "goal", operation: "create", request: { objective: "Read a file" } })
    const ref = { id: created.goal!.id, revision: created.goal!.revision }
    expect(created.goal!.phase).toBe("active")
    expect(created.goal!.maxGoalRounds).toBeUndefined()
    const paused = await workflow.mutate("s", { action: "goal", operation: "pause", request: { ref } })
    expect(paused.goal!.phase).toBe("paused")
    await expect(workflow.mutate("s", { action: "goal", operation: "edit", request: { ref, objective: "stale" } })).rejects.toThrow(/revision|stale/i)
    expect((await workflow.mutate("s", { action: "plan", enabled: true, proposal: "Inspect first" })).plan.active).toBe(true)
    const assembly = await service.assemblyFor("s")
    expect(assembly.session.events).toContainEqual(expect.objectContaining({ type: "user/message", text: "Inspect first" }))
    append(assembly.session, { type: "job/status", version: 1, job: { jobId: "job-1", kind: "shell", label: "test", status: "completed", outputAvailable: false } })
    await coordinator.flush("s")
    await service.closeSession("s")
    const restored = await workflow.read("s")
    expect(restored.goal!.phase).toBe("paused")
    expect(restored.plan.active).toBe(true)
    expect(restored.jobs).toMatchObject([{ jobId: "job-1", status: "completed", live: false, canCancel: false }])
  } finally { await workflow.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
it.each(["refused", "empty"] as const)("pauses an autonomous Goal after a provider %s result", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), "ih-goal-terminal-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s" })
  let calls = 0
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator),
    model: { async *stream() { calls++; yield { type: "end", ...(kind === "refused" ? { refused: true as const } : {}) } } } })
  const workflow = createDesktopWorkflow(coordinator, service)
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    await workflow.mutate("s", { action: "goal", operation: "create", request: { objective: "Do work" }, start: true })
    await vi.waitFor(async () => { const view = await workflow.read("s"); expect(view.goal?.phase).toBe("paused"); expect(view.goalRun?.error).toMatch(/refused|usable/i) })
    expect(calls).toBe(1)
  } finally { warn.mockRestore(); await workflow.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
it("contains background recovery persistence failures and reports them to the UI", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-goal-disk-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s" })
  const put = coordinator.putDocument.bind(coordinator)
  vi.spyOn(coordinator, "putDocument").mockImplementation(async (key, value) => { if (key.startsWith("desktop-goal-")) throw new Error("disk unavailable"); await put(key, value) })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model: { async *stream() { throw new Error("provider unavailable") } } })
  const errors: string[] = []
  const workflow = createDesktopWorkflow(coordinator, service, { onRunningChanged: (_id, running, error) => { if (!running && error) errors.push(error) } })
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    await workflow.mutate("s", { action: "goal", operation: "create", request: { objective: "Do work" }, start: true })
    await vi.waitFor(() => expect(errors.some((error) => error.includes("could not be saved"))).toBe(true))
    expect((await workflow.read("s")).goalRun?.error).toContain("disk unavailable")
  } finally { warn.mockRestore(); await workflow.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
it("forks a team conversation into an independent team while the source stays mounted", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-team-fork-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "source" })
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", coordinator, sessionFor: createDurableSessionLoader(coordinator), team: {}, concurrentSessionTeams: true })
  const workflow = createDesktopWorkflow(coordinator, service, { teamEnabled: true })
  try {
    const source = await service.assemblyFor("source")
    expect(source.tools.get("send_message")).toBeDefined()
    expect(source.tools.get("team_send_message")).toBeDefined()
    append(source.session, { type: "user/message", text: "source team work" })
    append(source.session, { type: "turn/start" })
    await workflow.mutate("source", { action: "team", tool: "team_task_create", args: { subject: "Source task", description: "keep in source" } })
    append(source.session, { type: "turn/end" })
    await coordinator.flush("source")
    const fork = await forkSession(coordinator, "source")
    expect((await workflow.read(fork.sessionId)).team.tasks).toEqual([])
    await workflow.mutate(fork.sessionId, { action: "team", tool: "team_task_create", args: { subject: "Fork task", description: "independent" } })
    expect((await workflow.read("source")).team.tasks.map((row) => row.subject)).toEqual(["Source task"])
    expect((await workflow.read(fork.sessionId)).team.tasks.map((row) => row.subject)).toEqual(["Fork task"])
  } finally { await workflow.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
it("restarts a paused Goal while the old aborted provider request is still settling", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-goal-resume-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s" })
  let release!: () => void
  const old = new Promise<void>((done) => { release = done })
  let calls = 0
  const states: boolean[] = []
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator),
    additionalTools: createDesktopGoalTools((id) => service.liveSession(id), () => {}),
    model: { async *stream(request) {
      if (++calls === 1) { await old; request.signal?.throwIfAborted() }
      else if (calls === 2) { const goal = foldGoal(service.liveSession("s")!.events)!; yield { type: "tool_call", call: { name: "goal_complete", args: { id: goal.id, revision: goal.revision } } } }
      else yield { type: "text/chunk", text: "Verified done" }
      yield { type: "end" }
    } } })
  const workflow = createDesktopWorkflow(coordinator, service, { onRunningChanged: (_id, value) => states.push(value) })
  try {
    const first = await workflow.mutate("s", { action: "goal", operation: "create", request: { objective: "Verify done" }, start: true })
    await vi.waitFor(() => expect(calls).toBe(1))
    const paused = await workflow.mutate("s", { action: "goal", operation: "pause", request: { ref: first.goal! } })
    await workflow.mutate("s", { action: "goal", operation: "resume", request: { ref: paused.goal! }, start: true })
    release()
    await vi.waitFor(async () => expect((await workflow.read("s")).goal?.phase).toBe("complete"))
    await vi.waitFor(() => expect(states.at(-1)).toBe(false))
    expect(calls).toBe(3)
    expect(states).toEqual([true, true, false])
  } finally { release(); await workflow.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
