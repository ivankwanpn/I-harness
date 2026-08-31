import { describe, expect, it, vi } from "vitest"
import { createSession, type SessionEvent } from "@i-harness/core-session"
import { createJobRegistry, type JobRegistry } from "../src/jobs.ts"
import { createAgentTable, type AgentTable } from "../src/agent-table.ts"
import { createRoleRegistry, builtinRoles, type RoleRegistry } from "../src/roles.ts"
import {
  emitRestoredJobTransitions,
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

  it("snapshotState/restoreState round-trip the child roleName", () => {
    const s = makeState()
    s.table.add("root/helper", {
      path: "root/helper", status: "waiting", session: (() => { const x = { formatVersion: 1, events: [] as never[] }; return x })(),
      controller: new AbortController(), mailbox: [], sessionId: "child-abc", roleName: "research",
    })
    const snap = snapshotState(s)
    expect(snap.agentTable[0]?.roleName).toBe("research")
    const fresh = makeState()
    restoreState(fresh, snap)
    expect(fresh.table.get("root/helper")?.roleName).toBe("research")
  })

  it("snapshotState/restoreState round-trip the inbox consumption cursor (lastInboxSeq)", () => {
    const s = makeState()
    s.table.add("root/helper", {
      path: "root/helper", status: "waiting", session: (() => { const x = { formatVersion: 1, events: [] as never[] }; return x })(),
      controller: new AbortController(), mailbox: [], sessionId: "child-abc", lastInboxSeq: 6,
    })
    const snap = snapshotState(s)
    expect(snap.agentTable[0]?.lastInboxSeq).toBe(6)
    const fresh = makeState()
    restoreState(fresh, snap)
    expect(fresh.table.get("root/helper")?.lastInboxSeq).toBe(6)
  })

  // M24a (G3): waiting fidelity — a waiting child is mid-conversation, not
  // dead; restore keeps it waiting so the followup re-drive (Task 3) can
  // resume it. Only "running" means the process is gone → error.
  it("restoreState keeps waiting entries waiting (only running → error)", () => {
    const fresh = makeState()
    const snap: SubagentStateSnapshot = {
      formatVersion: 1,
      jobs: [],
      agentTable: [{ path: "root/w", status: "waiting", mailbox: [] }],
      roles: [],
    }
    restoreState(fresh, snap)
    expect(fresh.table.get("root/w")?.status).toBe("waiting")
  })

  // M24a (G2): job-id contract — the persisted id is authoritative; restore
  // must NOT re-count ids (post-resume followups address jobs by persisted id).
  it("restoreState preserves persisted job ids (no re-count)", () => {
    const fresh = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    const snap = {
      formatVersion: 1,
      jobs: [{ id: "subagent-5", owner: "root", kind: "subagent", label: "helper", status: "completed", output: "done", terminal: true }],
      agentTable: [],
      roles: [],
    }
    restoreState(fresh, snap as never)
    expect(fresh.jobs.read("subagent-5").status).toBe("completed")
    expect(fresh.jobs.list("root").some((j) => j.id === "subagent-5")).toBe(true)
  })

  // M24a (G3): waiting→waiting and running→error in one restore pass.
  it("restoreState keeps waiting waiting; running → error", () => {
    const fresh = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    const snap = {
      formatVersion: 1,
      jobs: [],
      agentTable: [
        { path: "root/wait", status: "waiting", session: { formatVersion: 1, events: [] }, controller: new AbortController(), mailbox: [], sessionId: "c1" },
        { path: "root/run", status: "running", session: { formatVersion: 1, events: [] }, controller: new AbortController(), mailbox: [], sessionId: "c2" },
      ],
      roles: [],
    }
    restoreState(fresh, snap as never)
    expect(fresh.table.get("root/wait")!.status).toBe("waiting")
    expect(fresh.table.get("root/run")!.status).toBe("error")
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
      parentSessionId: "sess-main",
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

describe("task 4.4: job stamp persistence + job/status events", () => {
  it("snapshotState carries startedAt/endedAt; restoreState replays them verbatim", () => {
    const s = makeState()
    const { id } = s.jobs.registerJob("root", "subagent", "h", undefined, 10)
    s.jobs.updateJob(id, { status: "completed", output: "done", startedAt: 10, endedAt: 20 })
    const snap = snapshotState(s)
    expect(snap.jobs[0]).toMatchObject({ id, startedAt: 10, endedAt: 20, terminal: true })
    const fresh = makeState()
    restoreState(fresh, snap)
    expect(fresh.jobs.read(id)).toMatchObject({ startedAt: 10, endedAt: 20 })
  })

  it("wireSubagentPersistence with a parentSession appends a job/status event per real transition (and none for no-ops)", async () => {
    const s = makeState()
    const parent = createSession()
    const persist: SubagentPersistence = {
      coordinator: { putDocument: async () => {}, getDocument: async () => undefined } as unknown as SubagentPersistence["coordinator"],
      stateId: "subagent-state",
      parentSessionId: "sess-main",
      parentSession: parent,
    }
    const wired = wireSubagentPersistence(s, persist)
    const { id } = wired.jobs.registerJob("root", "subagent", "h")
    expect(parent.events.map((e) => e.type)).toEqual(["job/status"])
    const first = parent.events[0] as Extract<SessionEvent, { type: "job/status" }>
    expect(first.job).toMatchObject({ jobId: id, kind: "subagent", label: "h", status: "running", outputAvailable: false })
    expect(typeof first.job.startedAt).toBe("number")
    // completed transition → second event
    wired.jobs.updateJob(id, { status: "completed", output: "done" })
    expect(parent.events.map((e) => e.type)).toEqual(["job/status", "job/status"])
    const second = parent.events[1] as Extract<SessionEvent, { type: "job/status" }>
    expect(second.job).toMatchObject({ status: "completed", outputAvailable: true })
    expect(typeof second.job.endedAt).toBe("number")
    // updating the same terminal job with the same status/output again is a
    // no-op state change → NO spurious event (the wrapper compares snapshots).
    wired.jobs.updateJob(id, { status: "completed", output: "done" })
    expect(parent.events).toHaveLength(2)
    // kill on a finished job is a no-op → no event
    expect(wired.jobs.kill(id)).toBe("already-finished")
    expect(parent.events).toHaveLength(2)
  })

  it("wireSubagentPersistence WITHOUT a parentSession appends no events (additive-only)", async () => {
    const s = makeState()
    const persist: SubagentPersistence = {
      coordinator: { putDocument: async () => {}, getDocument: async () => undefined } as unknown as SubagentPersistence["coordinator"],
      stateId: "subagent-state",
      parentSessionId: "sess-main",
    }
    const wired = wireSubagentPersistence(s, persist)
    const { id } = wired.jobs.registerJob("root", "subagent", "h")
    wired.jobs.updateJob(id, { status: "completed", output: "x" })
    wired.jobs.kill(id)
    // nothing observable — only the doc writes happened (no session to assert on)
    expect(snapshotState({ jobs: wired.jobs, table: s.table, roles: s.roles }).jobs).toHaveLength(1)
  })

  // Task 4.4 (fix round 1) regression: restoreState maps running→"error" on the
  // RAW registry (pre-wiring) — the observe-wrapped registry can never see that
  // transition, so without emitRestoredJobTransitions the resumed evented log
  // would replay the pre-crash `running` event with nothing after it and a fold
  // would permanently disagree with the durable doc. The emit must replay the
  // mapped outcome for exactly the mid-flight jobs (and only when events are
  // opted in). Mirrors the registerSubagent ordering: restore on raw, wire,
  // then emit.
  it("emitRestoredJobTransitions replays the running→error mapping as a terminal job/status event (mid-flight only)", () => {
    const snap: SubagentStateSnapshot = {
      formatVersion: 1,
      jobs: [
        { id: "subagent-1", owner: "root", kind: "subagent", label: "midflight", status: "running", output: "", terminal: false, startedAt: 10 },
        { id: "subagent-2", owner: "root", kind: "subagent", label: "settled", status: "completed", output: "done", terminal: true, startedAt: 11, endedAt: 12 },
      ],
      agentTable: [],
      roles: [],
    }
    // 1. restore on raw registries (the pre-wire step in registerSubagent)
    const raw = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    restoreState(raw, snap)
    expect(raw.jobs.read("subagent-1").status).toBe("error") // mid-flight → error
    // 2. wire (observations on) with an evented parent session
    const parent = createSession()
    const persist: SubagentPersistence = {
      coordinator: { putDocument: async () => {}, getDocument: async () => undefined } as unknown as SubagentPersistence["coordinator"],
      stateId: "subagent-state",
      parentSessionId: "sess-main",
      parentSession: parent,
    }
    wireSubagentPersistence(raw, persist)
    // 3. emit the unobserved transition (the registerSubagent post-wire step)
    emitRestoredJobTransitions(persist, snap, raw.jobs)
    expect(parent.events.map((e) => e.type)).toEqual(["job/status"])
    const ev = parent.events[0] as Extract<SessionEvent, { type: "job/status" }>
    expect(ev.job).toMatchObject({
      jobId: "subagent-1", kind: "subagent", label: "midflight",
      status: "error", outputAvailable: true, startedAt: 10,
    })
    expect(typeof ev.job.endedAt).toBe("number")
  })

  it("emitRestoredJobTransitions is a no-op without a parentSession (additive-only)", () => {
    const snap: SubagentStateSnapshot = {
      formatVersion: 1,
      jobs: [{ id: "subagent-1", owner: "root", kind: "subagent", label: "mf", status: "running", output: "", terminal: false }],
      agentTable: [],
      roles: [],
    }
    const raw = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    restoreState(raw, snap)
    const persist: SubagentPersistence = {
      coordinator: { putDocument: async () => {}, getDocument: async () => undefined } as unknown as SubagentPersistence["coordinator"],
      stateId: "subagent-state",
      parentSessionId: "sess-main",
    }
    emitRestoredJobTransitions(persist, snap, raw.jobs)
    // no session to attach events to — the call resolves without throwing; the
    // registry outcome is unchanged (error mapping is untouched).
    expect(raw.jobs.read("subagent-1").status).toBe("error")
  })
})
