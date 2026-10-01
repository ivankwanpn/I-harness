import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionEvent } from "@i-harness/core-session"
import { createSessionCoordinator, type SessionCoordinator } from "@i-harness/session-persistence"
import type { SubagentStateSnapshot } from "@i-harness/subagent"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../../session-executor/src/index.ts"

function expectDense(events: SessionEvent[]): void {
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index))
}

it("keeps concurrent normal and teammate child logs positional through live checkpoint, followups and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "team-child-sequence-"))
  let release!: () => void
  const firstTurns = new Promise<void>((done) => { release = done })
  let calls = 0
  const child: ModelClient = { async *stream() {
    const turn = ++calls
    if (turn <= 2) await firstTurns
    yield { type: "text/chunk", text: `child result ${turn}` }
    yield { type: "end" }
  } }
  const parent: ModelClient = { async *stream() { yield { type: "text/chunk", text: "lead" }; yield { type: "end" } } }
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "lead" })
  const createService = (store: SessionCoordinator, restoredState?: SubagentStateSnapshot) => createSessionService({
    workspace: root, model: parent, coordinator: store, sessionFor: createDurableSessionLoader(store),
    team: {}, concurrentSessionTeams: true, restoredState,
    roleSelectionFor: () => ({ provider: "local", model: "child-fixture" }), allowSubagentModelSelection: true,
    resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
    parentNotify: { admit: async () => {}, wake: () => {} },
  })
  const service = createService(coordinator)
  let resumed: ReturnType<typeof createSessionService> | undefined
  let reopened: SessionCoordinator | undefined
  try {
    const assembly = await service.assemblyFor("lead")
    const execute = (name: string, args: unknown) => assembly.tools.get(name)!.execute(args, { sessionId: "lead" })
    const [normal] = await Promise.all([
      execute("spawn_agent", { task_name: "normal", message: "first normal", fork_turns: "none" }),
      execute("spawn_teammate", { name: "helper", description: "sequence fixture", prompt: "first teammate", context: "fresh" }),
    ]) as [{ agent_path: string }, unknown]
    await vi.waitFor(() => expect(calls).toBe(2))
    const agents = await execute("list_agents", {}) as { agents: Array<{ path: string; sessionId: string }> }
    const normalId = agents.agents.find((row) => row.path === normal.agent_path)!.sessionId
    const teammateId = agents.agents.find((row) => row.path === "lead/helper")!.sessionId
    const ids = [normalId, teammateId]
    // The checkpoint must only read the durable prefix. Both model streams
    // are still held, so no recovery closer can truthfully be committed.
    for (const id of ids) {
      await coordinator.flush(id)
      const { session } = await coordinator.snapshot!(id)
      expect(session.events.map((event) => event.type)).toEqual(["turn/start", "user/message", "step/start"])
      expectDense(session.events)
    }
    release()
    const waitForTurns = async (store: SessionCoordinator, count: number) => {
      await vi.waitFor(async () => {
        for (const id of ids) {
          await store.flush(id)
          const { session } = await store.snapshot!(id)
          expect(session.events.filter((event) => event.type === "turn/end"), id).toHaveLength(count)
          expectDense(session.events)
        }
      })
    }
    await waitForTurns(coordinator, 1)
    await execute("followup_task", { target: normal.agent_path, message: "second normal" })
    await execute("team_followup_task", { target: "helper", message: "second teammate" })
    await waitForTurns(coordinator, 2)
    await vi.waitFor(() => expect(service.tasks("lead").some((row) => row.status === "running")).toBe(false))
    await coordinator.close()
    const state = await coordinator.getDocument("lead") as SubagentStateSnapshot
    expect(state.agentTable.map((entry) => entry.sessionId)).toEqual(expect.arrayContaining(ids))
    await service.close()
    await coordinator.close()
    reopened = createSessionCoordinator(createJsonlBackend(root))
    // Strict owned recovery must accept both histories unchanged.
    for (const id of ids) expectDense((await reopened.loadOwned(id)).session.events)
    resumed = createService(reopened, state)
    const restored = await resumed.assemblyFor("lead")
    expect((await restored.tools.get("list_agents")!.execute({}, { sessionId: "lead" }) as { agents: Array<{ path: string; status: string; error?: string }> }).agents.map(({ path, status, error }) => ({ path, status, error }))).toEqual(expect.arrayContaining([
      { path: normal.agent_path, status: "waiting", error: undefined }, { path: "lead/helper", status: "waiting", error: undefined },
    ]))
    await restored.tools.get("followup_task")!.execute({ target: normal.agent_path, message: "third normal after restart" }, { sessionId: "lead" })
    await restored.tools.get("team_followup_task")!.execute({ target: "helper", message: "third teammate after restart" }, { sessionId: "lead" })
    await waitForTurns(reopened, 3)
    expect(calls).toBe(6)
    for (const id of ids) {
      const events = (await reopened.snapshot!(id)).session.events
      expect(events.filter((event) => event.type === "subagent/inbox")).toHaveLength(2)
      expect(events.filter((event) => event.type === "user/message")).toHaveLength(3)
    }
  } finally {
    release()
    await vi.waitFor(() => expect(service.tasks("lead").some((row) => row.status === "running")).toBe(false))
    await resumed?.close()
    await reopened?.close()
    await service.close()
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})
