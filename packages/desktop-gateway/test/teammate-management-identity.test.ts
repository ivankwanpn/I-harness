import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { ModelClient } from "../../llm-seam/src/index.ts"
import { createSessionService } from "@i-harness/session-executor"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"

it("exposes a teammate's exact management path and job/session identity and closes that real child by the returned path", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-teammate-identity-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "parent" })
  const release = Promise.withResolvers<void>()
  const child: ModelClient = { async *stream(request) {
    request.signal?.addEventListener("abort", () => release.resolve(), { once: true })
    await release.promise
    request.signal?.throwIfAborted()
    yield { type: "text/chunk", text: "Child done" }; yield { type: "end" }
  } }
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
    const cold = await coordinator.snapshot!(spawned.member.sessionId)
    expect(cold.session.header?.parentSession).toBe("parent")
  } finally { release.resolve(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
