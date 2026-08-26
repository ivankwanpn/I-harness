// TDD: mountAgentTeams lifecycle (M19 Task 10) — REAL wiring test.
//
// Binding corrections (controller, Rulings 17-21): the plan's test cast
// `subagents` as never and skipped typecheck, but the real scheduler derefs
// `subagents.table/jobs/roles/agents`, so this test passes REAL registries
// (createAgentTable/createJobRegistry/createRoleRegistry/createAgentRegistry)
// plus REAL createSession/createToolRegistry, and uses the test-only override
// seams (TeamDeps.spawnChild?/childSessionHoldsPrompt?/interruptChild?/
// closeChild?/deliver?/memberStatus?) so the lifecycle runs without spawning
// real subagent processes.
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

const TEAM_TOOL_NAMES = [
  "spawn_teammate", "list_members", "send_message", "followup_task", "wait_agent", "interrupt_agent",
  "team_task_create", "team_task_list", "team_task_get", "team_task_update",
]

function makeDeps(): TeamDeps {
  const model: ModelClient = { stream: async function* () { yield { type: "end" } as const } }
  return {
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
    parentModel: model,
    // Test-only override seams (Ruling 20): when present they are used, and the
    // real subagent spawnChild/coordinator bindings are skipped.
    spawnChild: async (name) => ({ path: `lead/${name}`, jobId: `team-job-${name}`, sessionId: `child-${name}` }),
    childSessionHoldsPrompt: async () => true,
    childSessionIsDurable: async () => true,
    interruptChild: async () => "running",
    closeChild: async () => {},
    deliver: async () => true,
  }
}

describe("mountAgentTeams lifecycle", () => {
  it("mount registers the 10 team tools; unmount unregisters them (idempotent)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const handle = await mountAgentTeams(ctx, tools, makeDeps())
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
    const handle = await mountAgentTeams(ctx, tools, makeDeps())
    try {
      await expect(mountAgentTeams(createContext(), createToolRegistry(createContext()), makeDeps()))
        .rejects.toThrow(/only one team per run/)
    } finally {
      await handle.unmount() // the live mount must not leak into other tests
    }
    // after the first mount unmounted, a fresh mount works again
    const h2 = await mountAgentTeams(createContext(), createToolRegistry(createContext()), makeDeps())
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
    const handle = await mountAgentTeams(ctx, tools, makeDeps())
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
})
