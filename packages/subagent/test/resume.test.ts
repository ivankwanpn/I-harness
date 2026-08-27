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
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable, type ChildAgentEntry } from "../src/agent-table.ts"
import { createSubagentTools, driveFollowups, ensureResidentAgent, type SubagentToolDeps } from "../src/tools.ts"

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
