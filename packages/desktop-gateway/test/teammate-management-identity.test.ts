import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { ModelClient } from "../../llm-seam/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import type { SubagentStateSnapshot } from "@i-harness/subagent"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"

it("exposes a teammate's exact management path and job/session identity and closes that real child by the returned path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-teammate-identity-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "parent" })
  const release = Promise.withResolvers<void>()
  const child: ModelClient = controlledModel(request => ({ async *stream(request) {
    request.signal?.addEventListener("abort", () => release.resolve(), { once: true })
    await release.promise
    request.signal?.throwIfAborted()
    yield { type: "text/chunk", text: "Child done" }; yield { type: "end" }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", coordinator, sandbox: "read-only", approveAll: true,
    team: {}, concurrentSessionTeams: true, roleSelectionFor: () => ({ provider: "fixture", model: "child" }), allowSubagentModelSelection: true,
    resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
  })
  try {
    const assembly = await service.assemblyFor("parent")
    const dispatch = async (name: string, args: unknown) => assembly.tools.dispatch(await assembly.tools.prepare({ name, args }, undefined, { sessionId: "parent" }))
    const spawned = await dispatch("spawn_teammate", { name: "env-probe", description: "Held child", prompt: "Wait" }) as { member: { agentPath: string; jobId: string; sessionId: string } }
    expect(spawned.member.agentPath).toBe("lead/env-probe")
    expect(spawned.member.jobId).toMatch(/^subagent-\d+$/)
    expect(spawned.member.sessionId).toMatch(/^child-/)
    const listed = await dispatch("list_members", {}) as { members: unknown[] }
    expect(listed.members).toContainEqual(expect.objectContaining(spawned.member))
    const agents = await dispatch("list_agents", {}) as { agents: unknown[] }
    expect(agents.agents).toContainEqual(expect.objectContaining({ path: spawned.member.agentPath, jobId: spawned.member.jobId, sessionId: spawned.member.sessionId }))
    const jobs = await dispatch("job_list", {}) as { jobs: unknown[] }
    expect(jobs.jobs).toContainEqual(expect.objectContaining({ id: spawned.member.jobId, agent_path: spawned.member.agentPath, session_id: spawned.member.sessionId }))
    await dispatch("close_agent", { target: spawned.member.agentPath })
    await vi.waitFor(() => expect(assembly.subagentState().agentTable).toEqual([]))
    expect(assembly.subagentState().jobs.find(job => job.id === spawned.member.jobId)?.status).toBe("killed")
    const closedJobs = await dispatch("job_list", {}) as { jobs: unknown[] }
    expect(closedJobs.jobs).toContainEqual(expect.objectContaining({ id: spawned.member.jobId, agent_path: spawned.member.agentPath, session_id: spawned.member.sessionId }))
    await expect(dispatch("close_agent", { target: spawned.member.agentPath })).resolves.toEqual({ previous_status: "inactive" })
    const cold = await coordinator.snapshot!(spawned.member.sessionId)
    expect(cold.session.header?.parentSession).toBe("parent")
  } finally { release.resolve(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("closes a historical roster member whose runtime table was removed by an older app", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-historical-teammate-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "parent" })
  await coordinator.create({ sessionId: "old-child", origin: "subagent", parentSession: "parent" })
  await coordinator.append("old-child", [{ type: "user/message", seq: 0, text: "Previous work" }, { type: "turn/start", seq: 1 }, { type: "turn/end", seq: 2 }])
  await coordinator.append("parent", [{ type: "team/member", version: 1, seq: 0, teamId: "old-team", member: {
    id: "old-member", name: "env-probe", description: "Previous version teammate", provider: "spawn", context: "fresh", phase: "provisioning",
  } }, { type: "team/member", version: 1, seq: 1, teamId: "old-team", member: {
    id: "old-member", name: "env-probe", description: "Previous version teammate", provider: "spawn", context: "fresh", phase: "active", sessionId: "old-child",
  } }])
  await coordinator.putDocument("parent", { formatVersion: 1, jobs: [], agentTable: [], roles: [] })
  const before = await coordinator.snapshot!("old-child")
  await coordinator.close()
  const reopened = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", coordinator: reopened, sessionFor: createDurableSessionLoader(reopened),
    restoredState: await reopened.getDocument("parent") as SubagentStateSnapshot, sandbox: "read-only", approveAll: true, team: {}, concurrentSessionTeams: true })
  try {
    const assembly = await service.assemblyFor("parent")
    const dispatch = async (name: string, args: unknown) => assembly.tools.dispatch(await assembly.tools.prepare({ name, args }, undefined, { sessionId: "parent" }))
    const listed = await dispatch("list_members", {}) as { members: { name: string; agentPath?: string; status: string }[] }
    const historical = listed.members.find(member => member.name === "env-probe")!
    expect(historical).toMatchObject({ agentPath: "lead/env-probe", status: "inactive" })
    await expect(dispatch("close_agent", { target: historical.agentPath })).resolves.toEqual({ previous_status: "inactive" })
    await expect(dispatch("close_agent", { target: historical.agentPath })).resolves.toEqual({ previous_status: "inactive" })
    await expect(dispatch("close_agent", { target: "lead/never-existed" })).rejects.toThrow(/unknown subagent/)
    await expect(dispatch("close_agent", { target: "root/env-probe" })).rejects.toThrow(/unknown subagent/)
    expect(assembly.subagentState().agentTable).toEqual([])
    expect(await reopened.snapshot!("old-child")).toEqual(before)
  } finally { await service.close(); await reopened.close(); await rm(root, { recursive: true, force: true }) }
})

it("retains a closed teammate job's identity after coordinator and app restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-teammate-job-restore-"))
  const storeRoot = join(root, "sessions")
  const coordinator = createSessionCoordinator(createJsonlBackend(storeRoot))
  await coordinator.create({ sessionId: "parent" })
  const child: ModelClient = controlledModel(request => ({ async *stream() { yield { type: "text/chunk", text: "Child done" }; yield { type: "end" } } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", coordinator, sandbox: "read-only", approveAll: true, team: {}, concurrentSessionTeams: true,
    roleSelectionFor: () => ({ provider: "fixture", model: "child" }), allowSubagentModelSelection: true,
    resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
  })
  let reopened: ReturnType<typeof createSessionCoordinator> | undefined
  let restarted: ReturnType<typeof createSessionService> | undefined
  try {
    const assembly = await service.assemblyFor("parent")
    const dispatch = async (name: string, args: unknown) => assembly.tools.dispatch(await assembly.tools.prepare({ name, args }, undefined, { sessionId: "parent" }))
    const spawned = await dispatch("spawn_teammate", { name: "finished", description: "Completed fixture", prompt: "Finish" }) as { member: { agentPath: string; jobId: string; sessionId: string } }
    await vi.waitFor(() => expect(assembly.subagentState().jobs.find(job => job.id === spawned.member.jobId)?.status).toBe("completed"))
    await dispatch("close_agent", { target: spawned.member.agentPath })
    await service.close()
    await coordinator.close()
    reopened = createSessionCoordinator(createJsonlBackend(storeRoot))
    restarted = createSessionService({ workspace: root, modelPolicy: "test-mock", coordinator: reopened, sessionFor: createDurableSessionLoader(reopened),
      restoredState: await reopened.getDocument("parent") as SubagentStateSnapshot, sandbox: "read-only", approveAll: true, team: {}, concurrentSessionTeams: true })
    const restored = await restarted.assemblyFor("parent")
    const jobs = await restored.tools.dispatch(await restored.tools.prepare({ name: "job_list", args: {} }, undefined, { sessionId: "parent" })) as { jobs: unknown[] }
    expect(jobs.jobs).toContainEqual(expect.objectContaining({ id: spawned.member.jobId, status: "completed", agent_path: "lead/finished", session_id: spawned.member.sessionId }))
    const output = await restored.tools.dispatch(await restored.tools.prepare({ name: "job_output", args: { job_id: spawned.member.jobId } }, undefined, { sessionId: "parent" }))
    expect(output).toMatchObject({ status: "completed", text: expect.stringContaining("Child done") })
  } finally { await restarted?.close(); await reopened?.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
