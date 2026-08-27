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
import { describe, expect, it, vi } from "vitest"
import { mountAgentTeams, type TeamDeps } from "../src/index.ts"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession, type SessionEvent } from "@i-harness/core-session"
import { createAgentTable, createJobRegistry, createRoleRegistry } from "@i-harness/subagent"
import { createAgentRegistry, type Agent } from "@i-harness/core-agent"
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
    // coordinator whose flush fails ONLY on the CHILD session ("sess-1") —
    // the parent session log must still commit (that is the queue's
    // durability), while the deliver write-behind durability point fails
    // (write-behind durability failure on the target).
    const failingCoordinator = {
      flush: async (sessionId: string) => { if (sessionId === "sess-1") throw new Error("disk full") },
    } as unknown as SessionCoordinator
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

  it("resolveCaller maps a teammate ToolExec.sessionId to the exact member identity", async () => {
    // M19 Ruling 24: a teammate's tool call carries the durable child session
    // id on ToolExec.sessionId. The scheduler must resolve it to the MEMBER
    // (roster id + name), never to the lead — otherwise a teammate's
    // send_message to "lead" is falsely rejected as TEAM_SELF_MESSAGE (the
    // old resolve-callers-to-lead behavior), and a message to another
    // teammate is recorded with the LEAD's senderId/senderName.
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const parentSession = createSession()
    parentSession.events.push(
      { type: "team/member", version: 1, teamId: "lead-123", member: { id: "child-a", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 1, teamId: "lead-123", member: { id: "child-a", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active", sessionId: "sess-helper" } },
      { type: "team/member", version: 1, teamId: "lead-123", member: { id: "child-b", name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 1, teamId: "lead-123", member: { id: "child-b", name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "active", sessionId: "sess-worker" } },
    )
    const table = createAgentTable()
    const entryHelper = createSession()
    const entryWorker = createSession()
    table.add("lead/helper", { path: "lead/helper", status: "waiting", session: entryHelper, controller: new AbortController(), mailbox: [], sessionId: "sess-helper" })
    table.add("lead/worker", { path: "lead/worker", status: "waiting", session: entryWorker, controller: new AbortController(), mailbox: [], sessionId: "sess-worker" })
    const handle = await mountAgentTeams(ctx, tools, makeDeps({ parentSession, subagents: { ...makeDeps().subagents, table } }))
    try {
      const send = tools.get("send_message")!
      // 1) helper → lead: succeeds (no TEAM_SELF_MESSAGE) and is recorded with
      //    the MEMBER's identity, not teamId/"lead".
      const out1 = (await send.execute({ target: "lead", message: "status" }, { sessionId: "sess-helper" })) as { status: string }
      expect(out1.status).toBe("accepted")
      const m1 = parentSession.events.find((e) => e.type === "team/message/queued")?.message as { senderId: string; senderName: string; targetId: string }
      expect(m1.senderId).toBe("child-a")
      expect(m1.senderName).toBe("helper")
      expect(m1.targetId).toBe("lead-123")
      // 2) helper → worker: member-to-member message carries the member ids.
      const out2 = (await send.execute({ target: "worker", message: "task" }, { sessionId: "sess-helper" })) as { status: string }
      expect(out2.status).toBe("accepted")
      const m2 = parentSession.events.filter((e) => e.type === "team/message/queued")[1]?.message as { senderId: string; senderName: string; targetId: string }
      expect(m2.senderId).toBe("child-a")
      expect(m2.senderName).toBe("helper")
      expect(m2.targetId).toBe("child-b")
      // 3) helper → helper (self): the member identity is EXACT, so it is
      //    rejected — with caller.id = teamId this check could never fire.
      await expect(send.execute({ target: "helper", message: "self" }, { sessionId: "sess-helper" })).rejects.toThrow(/cannot message yourself/)
      // 4) the LEAD's session id (parent) resolves to the lead, not a member.
      const out4 = (await send.execute({ target: "helper", message: "go" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out4.status).toBe("accepted")
      const m4 = parentSession.events.filter((e) => e.type === "team/message/queued").at(-1)?.message as { senderId: string; senderName: string }
      expect(m4.senderId).toBe("lead-123")
      expect(m4.senderName).toBe("lead")
    } finally {
      await handle.unmount()
    }
  })

  it("spawn_teammate threads fork_turns to the spawn bridge", async () => {
    // M19 Ruling 27: the roster bound fork_turns to the tool but the bridge
    // call dropped it. With the seam override we observe the LAST argument:
    // fork_turns: "3" (string from the tool) must reach the bridge normalized
    // to forkTurns: 3 with context "fork".
    let seen: { context: string; opts?: { forkTurns?: "none" | "all" | number } } | undefined
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const handle = await mountAgentTeams(ctx, tools, makeDeps({
      childSessionHoldsPrompt: async () => true,
      spawnChild: async (name, _prompt, context, opts) => {
        seen = { context, opts }
        return { path: `lead/${name}`, jobId: `j-${name}`, sessionId: `s-${name}` }
      },
    }))
    try {
      const spawn = tools.get("spawn_teammate")!
      const out = (await spawn.execute({ name: "helper", description: "d", prompt: "work", context: "fork", fork_turns: "3" }, {})) as { member: { name: string } }
      expect(out.member.name).toBe("helper")
      expect(seen).toEqual({ context: "fork", opts: { forkTurns: 3 } })
    } finally {
      await handle.unmount()
    }
  })

  it("wait_agent wakes on the spawn-completion status edge (running→waiting)", async () => {
    // M19 Ruling 26: a child's initial turn completing after spawn flips its
    // status running→waiting WITHOUT appending any team event — a wait_agent
    // waiter registered during the turn would otherwise sleep until timeout.
    // The REAL spawn bridge + REAL agent loop are used with a gated mock
    // model: the child's turn is HELD (table status "running") until the wait
    // has registered, then released — the edge fires while the waiter is
    // inside its wait, deterministically. The roster's durability checkpoint
    // is satisfied by an in-memory coordinator (write-behind mirror
    // semantics: enqueue + flush + load).
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const parentSession = createSession()

    const memSessions = new Map<string, SessionEvent[]>()
    const coordinator = {
      create: async (meta?: { sessionId?: string }) => {
        const id = meta?.sessionId ?? `mem-${memSessions.size}`
        memSessions.set(id, [])
        return { id }
      },
      append: async (sessionId: string, events: SessionEvent[]) => { memSessions.get(sessionId)?.push(...events) },
      enqueue: (sessionId: string, events: SessionEvent[]) => {
        const list = memSessions.get(sessionId) ?? []
        list.push(...events)
        memSessions.set(sessionId, list)
      },
      load: async (sessionId: string) => ({ session: { formatVersion: 1, events: [...(memSessions.get(sessionId) ?? [])] } }),
      list: async () => [...memSessions.keys()],
      flush: async () => {},
      close: async () => {},
      putDocument: async () => {},
      getDocument: async () => undefined,
    } as unknown as SessionCoordinator

    // The child's turn blocks on the gate, so it is provably still RUNNING
    // while wait_agent below registers (spawn returns after the agent started,
    // not after it finished).
    let releaseTurn!: () => void
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve })
    const gatedModel: ModelClient = {
      async *stream() {
        await turnGate
        yield { type: "text/chunk", text: "child turn done" }
        yield { type: "end" }
      },
    }

    const handle = await mountAgentTeams(ctx, tools, makeDeps({
      parentSession,
      parentModel: gatedModel,
      subagents: {
        table: createAgentTable(),
        jobs: createJobRegistry(),
        roles: createRoleRegistry(),
        agents: createAgentRegistry(),
        exec: createExecService(),
        providers: createProviderRegistry(),
        childSessions: { coordinator, parentSessionId: "sess-parent" },
      },
    }))
    try {
      const spawn = tools.get("spawn_teammate")!
      const out = (await spawn.execute({ name: "helper", description: "d", prompt: "work" }, {})) as { member: { name: string } }
      expect(out.member.name).toBe("helper")
      // The default timeout is 30s; the wait MUST resolve on the edge long
      // before it.
      const wait = tools.get("wait_agent")!
      const waitP = wait.execute({ timeout_ms: 30_000 }, {})
      releaseTurn() // now the child's turn completes → running→waiting edge
      const res = (await waitP) as { timedOut: boolean }
      expect(res.timedOut).toBe(false)
    } finally {
      await handle.unmount()
    }
  })

  // M23 (Minor 4): after a resume the subagent Agent registry is fresh-empty
  // and restoreState maps a running/waiting teammate to status "error" — the
  // old realDeliver gate rejected such targets outright, so a pre-resume
  // wakeup stayed queued forever (recoverRoot retried into the same gate).
  // With TeamSubagentDeps.ensureResident injected (run.ts wires registerSubagent's
  // lazy rebuild), the gate rebuilds the resident agent first and the wakeup
  // drive actually runs.
  function errorTeammateFixture() {
    const parentSession = createSession()
    parentSession.events.push(
      { type: "team/member", version: 1, teamId: "lead-t", member: { id: "child-abc", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 1, teamId: "lead-t", member: { id: "child-abc", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "active", sessionId: "sess-1" } },
    )
    const table = createAgentTable()
    const entrySession = createSession()
    // restoreState shape: running/waiting → "error", no resident agent.
    table.add("lead/helper", { path: "lead/helper", status: "error", session: entrySession, controller: new AbortController(), mailbox: [], sessionId: "sess-1", roleName: "general" })
    return { parentSession, table, entrySession }
  }

  it("realDeliver keeps the conservative queue behavior for an error-status teammate WITHOUT the rebuild seam", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const { parentSession, table, entrySession } = errorTeammateFixture()
    const deps = makeDeps({ parentSession, subagents: { ...makeDeps().subagents, table } })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const follow = tools.get("followup_task")!
      const out = (await follow.execute({ target: "helper", message: "wake" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out.status).toBe("queued") // not delivered → recoverRoot retries
      expect(entrySession.events.filter((e) => e.type === "subagent/inbox")).toHaveLength(0)
      expect(parentSession.events.filter((e) => e.type === "team/message/delivered")).toHaveLength(0)
    } finally {
      await handle.unmount()
    }
  })

  it("realDeliver rebuilds an error-status teammate via ensureResident and the wakeup drive runs", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const { parentSession, table, entrySession } = errorTeammateFixture()
    const agents = createAgentRegistry()
    // The lazy rebuild (mirrors registerSubagent's ensureResident): registers
    // a live agent whose followup runs the wakeup turn.
    const followup = vi.fn().mockResolvedValue({ finalText: "woken", turns: 1, reasoning: [] })
    const fakeAgent: Agent = { run: vi.fn(), followup }
    const ensureResident = async (entry: { sessionId?: string }) => {
      if (!entry.sessionId) return false
      agents.register(entry.sessionId, fakeAgent)
      return true
    }
    const deps = makeDeps({ parentSession, subagents: { ...makeDeps().subagents, table, agents, ensureResident } })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const follow = tools.get("followup_task")!
      const out = (await follow.execute({ target: "helper", message: "wake" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out.status).toBe("accepted") // delivered after the rebuild
      // the inbox append went through the child's session mirror
      expect(entrySession.events.filter((e) => e.type === "subagent/inbox")).toHaveLength(1)
      expect(parentSession.events.filter((e) => e.type === "team/message/delivered")).toHaveLength(1)
      // the wakeup drive ran a followup turn on the REBUILT resident agent
      await vi.waitFor(() => expect(followup).toHaveBeenCalledWith(expect.stringContaining("wake"), expect.any(AbortSignal)))
    } finally {
      await handle.unmount()
    }
  })

  it("realDeliver keeps the message queued when ensureResident cannot rebuild", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const { parentSession, table, entrySession } = errorTeammateFixture()
    const deps = makeDeps({
      parentSession,
      subagents: { ...makeDeps().subagents, table, ensureResident: async () => false },
    })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const follow = tools.get("followup_task")!
      const out = (await follow.execute({ target: "helper", message: "wake" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out.status).toBe("queued")
      expect(entrySession.events.filter((e) => e.type === "subagent/inbox")).toHaveLength(0)
      expect(parentSession.events.filter((e) => e.type === "team/message/delivered")).toHaveLength(0)
    } finally {
      await handle.unmount()
    }
  })

  it("realDeliver still refuses a killed teammate even with the rebuild seam", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const { parentSession, table, entrySession } = errorTeammateFixture()
    table.get("lead/helper")!.status = "killed"
    let rebuildCalls = 0
    const deps = makeDeps({
      parentSession,
      subagents: { ...makeDeps().subagents, table, ensureResident: async () => { rebuildCalls++; return true } },
    })
    const handle = await mountAgentTeams(ctx, tools, deps)
    try {
      const follow = tools.get("followup_task")!
      const out = (await follow.execute({ target: "helper", message: "wake" }, { sessionId: "sess-parent" })) as { status: string }
      expect(out.status).toBe("queued")
      expect(rebuildCalls).toBe(0) // killed short-circuits BEFORE any rebuild attempt
      expect(entrySession.events.filter((e) => e.type === "subagent/inbox")).toHaveLength(0)
    } finally {
      await handle.unmount()
    }
  })
})
