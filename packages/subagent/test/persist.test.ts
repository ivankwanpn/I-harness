import { describe, expect, it, vi } from "vitest"
import { createJobRegistry, type JobRegistry } from "../src/jobs.ts"
import { createAgentTable, type AgentTable } from "../src/agent-table.ts"
import { createRoleRegistry, builtinRoles, type RoleRegistry } from "../src/roles.ts"
import {
  snapshotState, restoreState, persistentJobRegistry, persistentAgentTable,
  persistentRoleRegistry, wireSubagentPersistence,
  type SubagentStateSnapshot, type SubagentPersistence,
} from "../src/persist.ts"

function makeState(): { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry } {
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  return { jobs, table, roles }
}

describe("subagent state snapshot", () => {
  it("snapshotState captures jobs, settled agent entries, and roles", () => {
    const s = makeState()
    const { id } = s.jobs.registerJob("root", "subagent", "helper")
    s.jobs.updateJob(id, { status: "completed", output: "done" })
    const snap = snapshotState(s)
    expect(snap.formatVersion).toBe(1)
    expect(snap.jobs).toHaveLength(1)
    expect(snap.jobs[0]).toMatchObject({ id, status: "completed", output: "done", terminal: true })
    expect(snap.roles.map((r) => r.name)).toContain("general")
  })

  it("restoreState injects jobs, agent-table entries (running→error), and roles", () => {
    const fresh = makeState()
    const snap: SubagentStateSnapshot = {
      formatVersion: 1,
      jobs: [
        { id: "subagent-1", owner: "root", kind: "subagent", label: "h", status: "completed", output: "done", terminal: true },
        { id: "subagent-2", owner: "root", kind: "subagent", label: "h2", status: "running", output: "", terminal: false },
      ],
      agentTable: [
        { path: "root/helper", status: "completed", finalText: "done", mailbox: [] },
        { path: "root/running", status: "running", mailbox: [] },
      ],
      roles: [{ name: "custom", description: "d", systemPrompt: "p", tools: ["read"] }],
    }
    restoreState(fresh, snap)
    expect(fresh.jobs.read("subagent-1").status).toBe("completed")
    expect(fresh.jobs.read("subagent-2").status).toBe("error") // running job → error
    expect(fresh.jobs.read("subagent-2").output).toBe("interrupted by resume")
    expect(fresh.table.get("root/helper")?.status).toBe("completed")
    expect(fresh.table.get("root/running")?.status).toBe("error") // running → error
    expect(fresh.roles.get("custom")).toBeDefined()
    // restored entries have fresh (non-persisted) session/controller
    expect(typeof fresh.table.get("root/helper")?.session.events.push).toBe("function")
  })

  it("snapshotState/restoreState round-trip the child sessionId link", () => {
    const s = makeState()
    s.table.add("root/helper", {
      path: "root/helper", status: "completed", session: (() => { const x = { formatVersion: 1, events: [] as never[] }; return x })(),
      controller: new AbortController(), mailbox: [], sessionId: "child-abc",
    })
    const snap = snapshotState(s)
    expect(snap.agentTable[0]?.sessionId).toBe("child-abc")
    const fresh = makeState()
    restoreState(fresh, snap)
    expect(fresh.table.get("root/helper")?.sessionId).toBe("child-abc")
  })
})

describe("persistent wrappers", () => {
  it("persistentJobRegistry saves after registerJob/updateJob/kill", async () => {
    const jobs = createJobRegistry()
    const save = vi.fn(async () => {})
    const wrapped = persistentJobRegistry(jobs, save)
    const { id } = wrapped.registerJob("root", "subagent", "h")
    expect(save).toHaveBeenCalledTimes(1)
    expect(wrapped.kill(id)).toBe("cancellation-requested")
    expect(save).toHaveBeenCalledTimes(2)
    wrapped.updateJob(id, { status: "completed" })
    expect(save).toHaveBeenCalledTimes(3)
    // Already-terminal → no state change and no spurious save.
    expect(wrapped.kill(id)).toBe("already-finished")
    expect(save).toHaveBeenCalledTimes(3)
  })

  it("persistentAgentTable saves after add and remove", async () => {
    const table = createAgentTable()
    const save = vi.fn(async () => {})
    const wrapped = persistentAgentTable(table, save)
    wrapped.add("root/helper", { path: "root/helper", status: "running", session: (() => { const s = { formatVersion: 1, events: [] as never[] }; return s })(), controller: new AbortController(), mailbox: [] })
    expect(save).toHaveBeenCalledTimes(1)
    wrapped.remove("root/helper")
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("persistentRoleRegistry saves after register and remove", async () => {
    const roles = createRoleRegistry()
    const save = vi.fn(async () => {})
    const wrapped = persistentRoleRegistry(roles, save)
    wrapped.register({ name: "custom", description: "d", systemPrompt: "p", tools: [] })
    expect(save).toHaveBeenCalledTimes(1)
    wrapped.remove("custom")
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("wireSubagentPersistence returns wrapped registries that save the full snapshot on any mutation", async () => {
    const s = makeState()
    const saved: SubagentStateSnapshot[] = []
    const persist: SubagentPersistence = {
      coordinator: {
        putDocument: async (_k: string, data: unknown) => { saved.push(data as SubagentStateSnapshot) },
        getDocument: async () => undefined,
      } as unknown as SubagentPersistence["coordinator"],
      stateId: "subagent-state",
    }
    const wired = wireSubagentPersistence(s, persist)
    wired.jobs.registerJob("root", "subagent", "h")
    expect(saved).toHaveLength(1)
    expect(saved[0]!.jobs).toHaveLength(1)
    wired.roles.register({ name: "custom", description: "d", systemPrompt: "p", tools: [] })
    expect(saved).toHaveLength(2)
    expect(saved[1]!.roles.map((r) => r.name)).toContain("custom")
  })
})
