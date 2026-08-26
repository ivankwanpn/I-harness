// TDD: mountAgentTeams lifecycle (M19 Task 10) — REAL wiring test.
//
// Binding corrections (controller, Rulings 17-22): the plan's test cast
// `subagents` as never and skipped typecheck, but the real scheduler derefs
// `subagents.table/jobs/roles/agents`, so this test passes REAL registries
// (createAgentTable/createJobRegistry/createRoleRegistry/createAgentRegistry)
// plus REAL createSession/createToolRegistry. The test-only override seams
// (TeamDeps.spawnChild?/childSessionHoldsPrompt?/IsDurable?/interruptChild?/
// closeChild?/deliver?/memberStatus?) keep the lifecycle real without spawning
// real subagent processes; fix-round-1 tests (Ruling 22) additionally verify
// the REAL deliver bridge (fail-closed flush) and the canonical-teamId
// restore path.
import { describe, expect, it } from "vitest"
import { mountAgentTeams, type TeamDeps } from "../src/index.ts"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createAgentTable, createJobRegistry, createRoleRegistry } from "@i-harness/subagent"
import { createAgentRegistry } from "@i-harness/core-agent"
import { createExecService } from "@i-harness/exec"
import { createProviderRegistry } from "@i-harness/provider"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"

const TEAM_TOOL_NAMES = [
  "spawn_teammate", "list_members", "send_message", "followup_task", "wait_agent", "interrupt_agent",
  "team_task_create", "team_task_list", "team_task_get", "team_task_update",
]

function model(): ModelClient {
  return { stream: async function* () { yield { type: "end" } as const } }
}

// Base fixture: real registries + real bridges (no override seams). Tests that
// spawn/send provide the seams they need — the base only mounts/unmounts, so
// the real bridge closures stay unused there.
function makeDeps(overrides?: Partial<TeamDeps>): TeamDeps {
  const deps: TeamDeps = {
    parentSession: createSession(),
    parentRegistry: createToolRegistry(createContext()),
    subagents: {
      table: createAgentTable(),
      jobs: createJobRegistry(),
      roles: createRoleRegistry(),
      agents: createAgentRegistry(),
      exec: createExecService(),
      providers: createProviderRegistry(),
    },
    parentModel: model(),
  }
  return overrides ? { ...deps, ...overrides } : deps
}

describe("mountAgentTeams lifecycle", () => {
  it("mount registers the 10 team tools; unmount unregisters them (idempotent)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) }))
    try {
      expect(tools.get("spawn_teammate")).toBeDefined()
      expect(tools.get("team_task_update")).toBeDefined()
      // exactly the 10 team tools — the names derived from createTeamTools, not a
      // hardcoded unregister list (no drift between mount and unmount)
      expect(tools.schemas().map((t) => t.name).sort()).toEqual([...TEAM_TOOL_NAMES].sort())
    } finally {
      await handle.unmount()
    }
    for (const name of TEAM_TOOL_NAMES) expect(tools.get(name)).toBeUndefined()
    await handle.unmount() // idempotent: second unmount is a no-op
  })

  it("throws on a second mount while one is live", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) }))
    try {
      await expect(mountAgentTeams(createContext(), createToolRegistry(createContext()), makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) })))
        .rejects.toThrow(/only one team per run/)
    } finally {
      await handle.unmount() // the live mount must not leak into other tests
    }
    // after the first mount unmounted, a fresh mount works again
    const h2 = await mountAgentTeams(createContext(), createToolRegistry(createContext()), makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) }))
    await h2.unmount()
  })

  it("rejects an invalid config before mounting", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    await expect(mountAgentTeams(ctx, tools, makeDeps(), { maxMembers: 0 }))
      .rejects.toThrow(/maxMembers must be a positive integer/)
    expect(tools.get("spawn_teammate")).toBeUndefined()
  })

  it("replaces subagent tool collisions on mount and restores them on unmount", async () => {
    // Real CLI flow: registerSubagent runs FIRST and mounts send_message /
    // followup_task / wait_agent / interrupt_agent (the subagent surface).
    // The team versions (same names, team semantics) must win during the run
    // and the subagent tools must be back after unmount — a true reverse.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const subagentSend = { name: "send_message", description: "subagent version", inputSchema: {}, isReadOnly: false, execute: async () => ({ queued: true }) }
    const subagentWait = { name: "wait_agent", description: "subagent version", inputSchema: {}, isReadOnly: false, execute: async () => ({ message: "", timed_out: false }) }
    tools.register(subagentSend)
    tools.register(subagentWait)
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }) }))
    try {
      const teamSend = tools.get("send_message")
      expect(teamSend?.description).not.toBe("subagent version")
      expect(tools.get("wait_agent")?.description).not.toBe("subagent version")
      expect(tools.get("spawn_teammate")).toBeDefined()
    } finally {
      await handle.unmount()
    }
    // subagent surface restored, team tools gone
    expect(tools.get("send_message")?.description).toBe("subagent version")
    expect(tools.get("interrupt_agent")).toBeUndefined() // not registered by the fixture
    expect(tools.get("spawn_teammate")).toBeUndefined()
  })

  it("deliver fails closed on a throwing write-behind flush — the message stays queued (no ack)", async () => {
    // Ruling 22 fix: the real deliver bridge flushes the target's write-behind
    // and returns FALSE on rejection. The mailbox then keeps the message queued
    // for recoverRoot (at-least-once) instead of acking a maybe-lost message.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const parentSession = createSession()
    // seed an active teammate (folded from the lead log) with a live table entry
    parentSession.events.push(
      { type: "team/member", version: 1, teamId: "lead-t", member: { id: "child-abc", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 1, teamId: "lead-t", member: { id: "child-abc", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active", sessionId: "sess-1" } },
    )
    const table = createAgentTable()
    const entrySession = createSession()
    table.add("lead/helper", { path: "lead/helper", status: "waiting", session: entrySession, controller: new AbortController(), mailbox: [], sessionId: "sess-1" })
    // coordinator whose flush ALWAYS throws (write-behind durability failure)
    const failingCoordinator = { flush: async () => { throw new Error("disk full") } } as unknown as SessionCoordinator
    const deps = makeDeps({
      parentSession,
      subagents: {
        table,
        jobs: createJobRegistry(),
        roles: createRoleRegistry(),
        agents: createAgentRegistry(),
        exec: createExecService(),
        providers: createProviderRegistry(),
        childSessions: { coordinator: failingCoordinator, parentSessionId: "lead-parent" },
      },
    })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const send = tools.get("send_message")!
      const out = (await send.execute({ target: "helper", message: "hi helper" }, {})) as { status: string; messageId: string }
      expect(out.status).toBe("queued")
      expect(out.messageId).toMatch(/^msg-/)
      // the message was queued in the lead log but NEVER acked — recoverRoot
      // will retry it (durability failure is not treated as delivered)
      expect(parentSession.events.filter((e) => e.type === "team/message/queued")).toHaveLength(1)
      expect(parentSession.events.filter((e) => e.type === "team/message/delivered")).toHaveLength(0)
    } finally {
      await handle.unmount()
    }
  })

  it("restore path derives the canonical teamId from the log and recovers lead-targeted messages", async () => {
    // Ruling 22 fix: a fresh randomly-minted teamId on restore would strand
    // every queued message whose targetId is the OLD lead id (recoverRoot
    // would resolve that id to nobody and never deliver). The canonical
    // teamId comes from the first team/* event in the folded log.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const parentSession = createSession()
    // a previous run's committed log: the queued message targets the OLD lead
    // id "lead-abc" and was never acked (no team/message/delivered after it)
    parentSession.events.push({
      type: "team/message/queued", version: 1, teamId: "lead-abc",
      message: { id: "msg-old", senderId: "child-z", senderName: "helper", targetId: "lead-abc", delivery: "wakeup", content: "report" },
    })
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ parentSession }))
    try {
      // the canonical lead id was NOT regenerated
      expect(handle.teamName).toBe("lead-abc")
      // recoverRoot delivered the old-lead-targeted message and acked it
      const delivered = parentSession.events.find((e) => e.type === "team/message/delivered")
      expect(delivered).toBeDefined()
      expect((delivered as { messageId: string }).messageId).toBe("msg-old")
    } finally {
      await handle.unmount()
    }
  })

  it("restore path deliver to the canonical lead still fails closed on a throwing flush", async () => {
    // Lead branch of realDeliver (Ruling 22): even though the canonical
    // teamId resolves, a throwing write-behind flush must NOT ack — the
    // message stays queued for the next recoverRoot.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const parentSession = createSession()
    parentSession.events.push({
      type: "team/message/queued", version: 1, teamId: "lead-abc",
      message: { id: "msg-old", senderId: "child-z", senderName: "helper", targetId: "lead-abc", delivery: "wakeup", content: "report" },
    })
    const failingCoordinator = { flush: async () => { throw new Error("disk full") } } as unknown as SessionCoordinator
    const deps = makeDeps({
      parentSession,
      subagents: {
        table: createAgentTable(),
        jobs: createJobRegistry(),
        roles: createRoleRegistry(),
        agents: createAgentRegistry(),
        exec: createExecService(),
        providers: createProviderRegistry(),
        childSessions: { coordinator: failingCoordinator, parentSessionId: "lead-parent" },
      },
    })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      expect(handle.teamName).toBe("lead-abc")
      // deliver appended the inbox event but the flush threw → delivered false
      // → no team/message/delivered ack; recoverRoot retries it next mount
      const deliv = parentSession.events.filter((e) => e.type === "team/message/delivered")
      expect(deliv).toHaveLength(0)
      expect(parentSession.events.filter((e) => e.type === "team/message/queued")).toHaveLength(1)
    } finally {
      await handle.unmount()
    }
  })
})
