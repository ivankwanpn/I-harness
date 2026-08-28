// M23 Task 6: `ensureResidentAgent` lazy rebuild (M19 Minor-4 wakeup no-op fix).
//
// On resume the subagent Agent registry is fresh-empty (entries are registered
// per spawn/turn). A wakeup (agent-team realDeliver "wakeup" drive or a
// followup_task) for a restored teammate found NO resident agent and silently
// dropped the drive. `ensureResidentAgent` extracts resume_agent's rebuild body
// so driveFollowups can lazily recreate the resident agent from the restored
// entry (durable session + role + model), and `driveFollowups` accepts an
// optional `rebuild` injection (backward-compatible: absent = old no-op).
import { describe, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { append, createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgentRegistry, type Agent } from "@i-harness/core-agent"
import { createProviderRegistry } from "@i-harness/provider"
import { createExecService } from "@i-harness/exec"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable, type ChildAgentEntry } from "../src/agent-table.ts"
import { createSubagentTools, driveFollowups, ensureResidentAgent, sweepPendingInbox, type SubagentToolDeps } from "../src/tools.ts"
import { registerSubagent } from "../src/index.ts"
import type { SubagentStateSnapshot } from "../src/persist.ts"

function setup() {
  const ctx = createContext()
  const parentReg = createToolRegistry(ctx)
  parentReg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
  const session = createSession()
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  const providers = createProviderRegistry()
  const exec = createExecService()
  const model = createMockClient([{ role: "assistant", text: "child done" }])
  const deps: SubagentToolDeps = {
    table, jobs, roles, parentRegistry: parentReg, parentSession: session, parentCtx: ctx,
    parentModel: model, providers, exec, agents: createAgentRegistry(),
  }
  return { deps, table, agents: deps.agents, jobs }
}

function restoredEntry(sessionId: string, roleName: string | undefined): ChildAgentEntry {
  const session = createSession()
  return {
    path: "root/helper",
    // restoreState maps running/waiting → "error" (process gone after resume)
    status: "error" as const,
    session,
    controller: new AbortController(),
    mailbox: [],
    sessionId,
    ...(roleName !== undefined ? { roleName } : {}),
  }
}

describe("ensureResidentAgent", () => {
  it("rebuilds a non-resident entry from the restored session + role and registers the agent", async () => {
    const { deps, table, agents } = setup()
    const entry = restoredEntry("child-1", "general")
    const oldController = entry.controller
    table.add(entry.path, entry)
    expect(agents.get("child-1")).toBeUndefined() // fresh registry (post-resume)

    const ok = await ensureResidentAgent(deps, entry)
    expect(ok).toBe(true)
    const rebuilt = agents.get("child-1")
    expect(rebuilt).toBeDefined()
    expect(typeof (rebuilt as Agent).run).toBe("function")
    expect(typeof (rebuilt as Agent).followup).toBe("function")
    // restored entry lifecycle fields refreshed (resume_agent parity)
    expect(entry.status).toBe("waiting")
    expect(entry.controller).not.toBe(oldController)
    expect(typeof entry.unmount).toBe("function")
  }, 10_000)

  it("returns true without rebuilding when the agent is already resident", async () => {
    const { deps, table, agents } = setup()
    const entry = restoredEntry("child-1", "general")
    table.add(entry.path, entry)
    const fakeAgent: Agent = { run: vi.fn(), followup: vi.fn() }
    agents.register("child-1", fakeAgent)

    const ok = await ensureResidentAgent(deps, entry)
    expect(ok).toBe(true)
    expect(agents.get("child-1")).toBe(fakeAgent) // NOT rebuilt
    // resident short-circuit: the entry is untouched
    expect(entry.status).toBe("error")
    expect(entry.unmount).toBeUndefined()
  }, 10_000)

  it("returns false (no throw) for an unknown role — the caller decides fail behavior", async () => {
    const { deps, table, agents } = setup()
    const entry = restoredEntry("child-1", "nope")
    table.add(entry.path, entry)

    const ok = await ensureResidentAgent(deps, entry)
    expect(ok).toBe(false)
    expect(agents.get("child-1")).toBeUndefined() // nothing registered
    expect(entry.status).toBe("error") // untouched
  }, 10_000)
})

describe("driveFollowups rebuild injection (M23 wakeup no-op fix)", () => {
  it("rebuilds the resident agent via the injected rebuild and drains the pending inbox", async () => {
    const { deps, table, agents } = setup()
    const entry = restoredEntry("child-1", "general")
    append(entry.session, { type: "subagent/inbox", messageId: "in-1", message: "wakeup after resume" })
    table.add(entry.path, entry)
    expect(agents.get("child-1")).toBeUndefined()

    const model = createMockClient([{ role: "assistant", text: "driven" }])
    const wakeDeps: SubagentToolDeps = { ...deps, parentModel: model }
    await driveFollowups({ ...wakeDeps, rebuild: (e) => ensureResidentAgent(wakeDeps, e) }, entry, "child-1")

    // the drive was NOT dropped: agent rebuilt + inbox turned
    expect(agents.get("child-1")).toBeDefined()
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("driven")
    expect(entry.session.events.some((e) => e.type === "user/message" && e.text === "wakeup after resume")).toBe(true)
  }, 10_000)

  it("without a rebuild stays a silent no-op for a non-resident entry (backward compat)", async () => {
    const { deps, table, agents } = setup()
    const entry = restoredEntry("child-1", "general")
    append(entry.session, { type: "subagent/inbox", messageId: "in-1", message: "wakeup after resume" })
    table.add(entry.path, entry)

    await driveFollowups(deps, entry, "child-1")
    expect(agents.get("child-1")).toBeUndefined() // no rebuild ability → no-op
    expect(entry.finalText).toBeUndefined()
    expect(entry.session.events.some((e) => e.type === "user/message")).toBe(false)
  }, 10_000)
})

describe("resume_agent semantics preserved", () => {
  it("still throws 'unknown role' for an unrebuildable target (explicit tool call errors)", async () => {
    const { deps, table } = setup()
    const entry = restoredEntry("child-1", "nope")
    table.add(entry.path, entry)
    const tools = createSubagentTools(deps)
    const resume = tools.find((t) => t.name === "resume_agent")!
    await expect(resume.execute({ target: "root/helper" }, {})).rejects.toThrow(/unknown role/)
  }, 10_000)

  it("rebuilds a non-resident entry and drains the pending inbox through resume_agent", async () => {
    const { deps, table, agents } = setup()
    const entry = restoredEntry("child-1", "general")
    append(entry.session, { type: "subagent/inbox", messageId: "in-1", message: "queued before resume" })
    table.add(entry.path, entry)
    const model = createMockClient([{ role: "assistant", text: "queued handled" }])
    const tools = createSubagentTools({ ...deps, parentModel: model })
    const resume = tools.find((t) => t.name === "resume_agent")!
    const out = await resume.execute({ target: "root/helper" }, {})
    expect(out).toEqual({ resumed: true })
    expect(agents.get("child-1")).toBeDefined()
    await entry.followupChain
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("queued handled")
  }, 10_000)
})

// M24a Task 3: G1a async mirror rebuild + G4 pending-inbox sweep + `ready`.
//
// On cold resume restoreState (SYNC — Ruling M24a-P2) rebuilds the registries
// with EMPTY stub sessions. registerSubagent then runs an async after-restore
// step behind `ready`: each restored child's durable log is loaded into a
// HOOKED mirror session (subsequent appends keep persisting through the
// write-behind), and entries still "waiting" with an unconsumed durable inbox
// event (seq > lastInboxSeq) get the same serialized followup drain a live
// wakeup would have given them (G4 — ONLY waiting: running→error needs an
// explicit resume_agent, Ruling M24a-P6). Hosts await `ready` BEFORE mounting
// agent teams: recoverRoot delivers queued team messages to entry.session,
// which must be a live mirror by then.
describe("M24a G1a async mirror + G4 pending-inbox sweep + ready", () => {
  function restoreFixture(): SubagentStateSnapshot {
    return {
      formatVersion: 1,
      jobs: [],
      agentTable: [
        { path: "root/helper", status: "waiting", mailbox: [], sessionId: "child-abc", roleName: "general", lastInboxSeq: 0 },
      ],
      roles: [],
    }
  }

  function mockCoordinator(over?: Partial<Record<"load" | "enqueue" | "flush", unknown>>) {
    return {
      load: vi.fn(async () => {
        throw new Error("missing log")
      }),
      enqueue: vi.fn(),
      flush: vi.fn(async () => {}),
      ...over,
    } as unknown as SessionCoordinator & Record<"load" | "enqueue" | "flush", ReturnType<typeof vi.fn>>
  }

  function registerWith(coordinator: SessionCoordinator, restoredState: SubagentStateSnapshot) {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    return registerSubagent(ctx, parentReg, {
      providers: createProviderRegistry(),
      exec: createExecService(),
      parentModel: createMockClient([{ role: "assistant", text: "ok" }]),
      parentSession: createSession(),
      restoredState,
      persist: { coordinator, stateId: "main", parentSessionId: "main" },
    })
  }

  it("registerSubagent rebuilds the hooked child mirror after restore (G1a) — append enqueues durably", async () => {
    const loadedSession = {
      formatVersion: 1,
      events: [{ type: "user/message", text: "old", seq: 0 }] as unknown[],
      header: { origin: "subagent", parentSession: "main" },
    }
    let releaseLoad: (value: { session: typeof loadedSession }) => void = () => {}
    const coordinator = mockCoordinator({
      load: vi.fn(() => new Promise<{ session: typeof loadedSession }>((resolve) => { releaseLoad = resolve })),
    })
    const subagent = registerWith(coordinator, restoreFixture())
    // The async mirror rebuild is IN FLIGHT: load was called, `ready` pending.
    expect(coordinator.load).toHaveBeenCalledWith("child-abc")
    let readyResolved = false
    void subagent.ready.then(() => { readyResolved = true })
    expect(readyResolved).toBe(false) // ready does NOT resolve before the mirror loads

    releaseLoad({ session: loadedSession })
    await subagent.ready
    expect(readyResolved).toBe(true)

    // G1a: the durable child log was rebuilt into the entry's mirror session
    const entry = subagent.table.get("root/helper")!
    expect(entry.status).toBe("waiting") // load succeeded → not failed-visible
    expect(entry.session.events.some((e) => e.type === "user/message" && e.text === "old")).toBe(true)
    expect(entry.session.header).toEqual({ origin: "subagent", parentSession: "main" })
    // The mirror is HOOKED: appends flow into the durable write-behind ...
    append(entry.session, { type: "subagent/inbox", messageId: "m1", message: "hi" })
    expect(coordinator.enqueue).toHaveBeenCalledWith("child-abc", [expect.objectContaining({ type: "subagent/inbox", message: "hi" })])
    // ... and a turn/end triggers the flush hook
    append(entry.session, { type: "turn/end" })
    expect(coordinator.flush).toHaveBeenCalledWith("child-abc")
  }, 10_000)

  it("fails visible when a child log is unavailable after resume (G1a)", async () => {
    const coordinator = mockCoordinator() // load rejects by default
    const subagent = registerWith(coordinator, restoreFixture())
    await subagent.ready
    const entry = subagent.table.get("root/helper")!
    // NOT a silent empty stub anymore: the entry fails visible so the caller
    // (wait_agent / list_agents) sees why the child is unusable.
    expect(entry.status).toBe("error")
    expect(entry.error).toBe("child log unavailable after resume")
  }, 10_000)

  it("ready resolves immediately when there is no restored state (no-op)", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    const subagent = registerSubagent(ctx, parentReg, {
      providers: createProviderRegistry(),
      exec: createExecService(),
      parentModel: createMockClient([{ role: "assistant", text: "ok" }]),
      parentSession: createSession(),
    })
    await expect(subagent.ready).resolves.toBeUndefined()
    expect(subagent.table.entries().size).toBe(0) // nothing restored, nothing swept
  })

  it("sweepPendingInbox rebuilds the resident and drives a waiting entry with seq > lastInboxSeq (G4)", async () => {
    const { deps, table, agents } = setup()
    const entry = restoredEntry("child-1", "general")
    entry.status = "waiting"
    append(entry.session, { type: "user/message", text: "seed turn" }) // seq 0
    append(entry.session, { type: "subagent/inbox", messageId: "m0", message: "consumed" }) // seq 1 (consumed pre-shutdown)
    append(entry.session, { type: "subagent/inbox", messageId: "m1", message: "pending" }) // seq 2 (queued before shutdown)
    entry.lastInboxSeq = 1
    table.add(entry.path, entry)
    expect(agents.get("child-1")).toBeUndefined() // fresh registry (post-resume)

    await sweepPendingInbox(deps, table)
    // the sweep rebuilt the resident agent and initiated the serialized drive
    expect(agents.get("child-1")).toBeDefined()
    await entry.followupChain // the drive is fire-and-forget; the chain serializes it
    expect(entry.status).toBe("waiting")
    expect(entry.finalText).toBe("child done")
    expect(entry.lastInboxSeq).toBe(2) // cursor advanced past the swept event
    expect(entry.session.events.some((e) => e.type === "user/message" && e.text === "pending")).toBe(true)
  }, 10_000)

  it("sweepPendingInbox skips non-waiting entries — running→error needs an explicit resume_agent (P6)", async () => {
    const { deps, table, agents } = setup()
    const entry = restoredEntry("child-1", "general") // status "error" (restoreState maps running→error)
    append(entry.session, { type: "subagent/inbox", messageId: "m1", message: "pending" }) // seq 0 > lastInboxSeq -1
    table.add(entry.path, entry)
    await sweepPendingInbox(deps, table)
    expect(agents.get("child-1")).toBeUndefined() // NOT rebuilt
    expect(entry.finalText).toBeUndefined() // not driven
    expect(entry.session.events.some((e) => e.type === "user/message")).toBe(false)
  }, 10_000)

  it("sweepPendingInbox leaves waiting entries with no unconsumed inbox untouched", async () => {
    const { deps, table, agents } = setup()
    const entry = restoredEntry("child-1", "general")
    entry.status = "waiting"
    table.add(entry.path, entry)
    await sweepPendingInbox(deps, table)
    expect(agents.get("child-1")).toBeUndefined() // nothing pending → no rebuild, no drive
    expect(entry.finalText).toBeUndefined()
  }, 10_000)
})
