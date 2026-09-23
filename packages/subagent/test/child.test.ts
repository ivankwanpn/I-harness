import { describe, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, type SessionEvent } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgentRegistry } from "@i-harness/core-agent"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { forkTurns } from "../src/fork.ts"
import { resolveRoleTools, spawnChild, type SpawnOptions } from "../src/child.ts"

function makeTool(name: string): Tool {
  return { name, description: "", inputSchema: {}, execute: async () => ({}) }
}

/** Every built-in role carries NO model, so the cases below never reach the
 * resolver — it is here because `spawnChild`'s seam is required. The cases that
 * exercise a role's model supply their own. */
const noRoleModel = async () => ({ status: "unconfigured" as const, reason: "unused" })

describe("fork.ts", () => {
  it("forkTurns returns the last N turn blocks", () => {
    const events: SessionEvent[] = []
    const push = (type: string, extra: Record<string, unknown> = {}) => events.push({ type, ...extra } as SessionEvent)
    push("turn/start"); push("user/message", { text: "a" }); push("assistant/message", { text: "A" }); push("turn/end")
    push("turn/start"); push("user/message", { text: "b" }); push("assistant/message", { text: "B" }); push("turn/end")
    const last = forkTurns(events, 1)
    expect(last.some((e) => (e as { text?: string }).text === "b")).toBe(true)
    expect(last.some((e) => (e as { text?: string }).text === "a")).toBe(false)
  })
})

describe("spawnChild", () => {
  it("spawns a background child with a role and resolves completion", async () => {
    const parentCtx = createContext()
    const parentReg = createToolRegistry(parentCtx)
    parentReg.register(makeTool("read"))
    const parentSession = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const model = createMockClient([{ role: "assistant", text: "child done" }])

    const { path, jobId } = await spawnChild({
      taskName: "helper",
      message: "do the thing",
      parentPath: "root",
      parentRegistry: parentReg,
      parentSession,
      parentCtx,
      role: roles.get("general")!,
      parentModel: model,
      resolveModel: noRoleModel,
      jobs,
      table,
      agents: createAgentRegistry(),
    })
    expect(path).toBe("root/helper")
    expect(jobId).toMatch(/^subagent-\d+$/)
    expect(table.get("root/helper")!.status).toBe("running")
    await new Promise((r) => setTimeout(r, 150))
    expect(table.get("root/helper")!.status).toBe("waiting")
    expect(jobs.read(jobId).status).toBe("completed")
  }, 10_000)
})

function fakeCoordinator(): SessionCoordinator & { created: SessionMeta[]; enqueued: { id: string; events: unknown[] }[]; flushed: { id: string; types: string[] }[] } {
  const created: SessionMeta[] = []
  const enqueued: { id: string; events: unknown[] }[] = []
  // M70: a flush is recorded with WHAT HAD BEEN ENQUEUED FOR THAT SESSION when
  // it ran. That is the discriminator this fake needs and the reason it is not
  // "flush was called" (this mirror also flushes on `turn/end`), but it is NOT
  // a model of the write-behind: the real drain persists a stable ordered
  // PREFIX and re-queues what a failed write retained, while this recording is
  // the whole enqueue history and never empties.
  const flushed: { id: string; types: string[] }[] = []
  return {
    created,
    enqueued,
    flushed,
    async create(meta) {
      created.push(meta as SessionMeta)
      return { id: (meta as { sessionId?: string }).sessionId ?? "sess-x" }
    },
    async append() {},
    enqueue(id, events) { enqueued.push({ id, events: [...events] }) },
    async load() { return { session: { formatVersion: 1, events: [] } } },
    async loadOwned() { return { session: { formatVersion: 1, events: [] } } },
    async list() { return [] },
    async flush(id) {
      flushed.push({
        id,
        types: enqueued.filter((batch) => batch.id === id).flatMap((batch) => batch.events.map((ev) => (ev as { type?: string }).type ?? "?")),
      })
    },
    async close() {},
    async putDocument() {},
    async getDocument() { return undefined },
    ownerOf() { return false },
    async adoptOwnership() {},
    async releaseOwnership() {},
    async profile() { throw new Error("unused") },
    async updateMeta() { throw new Error("unused") },
  }
}

describe("spawnChild durable child sessions (M8)", () => {
  it("with childSessions: creates a child-<uuid> session, mirrors seed + events, records sessionId", async () => {
    const coordinator = fakeCoordinator()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    roles.register({ name: "general", description: "d", systemPrompt: "p", tools: [] })
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    // two parent turns so forkTurns("all") has seed content
    parentSession.events.push({ type: "turn/start" }, { type: "user/message", text: "a" }, { type: "assistant/message", text: "b" }, { type: "turn/end" })
    const mock = createMockClient([{ role: "assistant", text: "ok" }])
    const agents = createAgentRegistry()

    const { path, sessionId } = await spawnChild({
      taskName: "helper",
      message: "hi",
      parentPath: "root",
      parentRegistry,
      parentSession,
      parentCtx: ctx,
      role: roles.get("general")!,
      parentModel: mock,
      resolveModel: noRoleModel,
      jobs,
      table,
      agents,
      childSessions: { coordinator, parentSessionId: "sess-main" },
    })
    expect(sessionId).toMatch(/^child-/)
    expect(path).toBe("root/helper")
    expect(coordinator.created).toHaveLength(1)
    expect(coordinator.created[0]).toMatchObject({ sessionId, parentSession: "sess-main", origin: "subagent", seedLength: 4, delegationDepth: 1 })
    // append() fires the mirror once per event → the 4 fork-seed events are
    // enqueued as single-event batches (seq 0..3). The child's own run appends
    // further events right after spawnChild returns, so only the seed prefix is
    // asserted (count is >= 4, not exactly 4).
    expect(coordinator.enqueued.length).toBeGreaterThanOrEqual(4)
    expect(coordinator.enqueued[0]!.id).toBe(sessionId)
    expect(coordinator.enqueued[0]!.events).toHaveLength(1)
    expect(coordinator.enqueued.slice(0, 4).map((b) => (b.events[0]! as { type: string }).type))
      .toEqual(["turn/start", "user/message", "assistant/message", "turn/end"])
    const entry = table.get("root/helper")
    expect(entry?.sessionId).toBe(sessionId)
    expect(entry?.session.header).toMatchObject({ parentSession: "sess-main", origin: "subagent", delegationDepth: 1, seedLength: 4 })
    expect(agents.get(sessionId!)).toBeDefined() // agent retained in the registry
  })

  // M70: the child's OWN dispatch boundary is checkpointed, through the same
  // coordinator and under its OWN session id. Measured before wiring it: this
  // child's appends are mirrored into `childSessions.coordinator` by the session
  // hook, so `coordinator.flush(childSessionId)` drains the very write-behind
  // that received the `tool/dispatch` marker.
  it("M70: a child's tool dispatch is durable BEFORE its body — flushed under the child's own id", async () => {
    const coordinator = fakeCoordinator()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    roles.register({ name: "general", description: "d", systemPrompt: "p", tools: ["read"] })
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()

    // What the body could observe at its first statement, and the only
    // observable that DISCRIMINATES: this file also flushes on `turn/end`, so a
    // "flush happened" test would be green with or without the checkpoint. This
    // snapshots the drains so far (and what each of them was draining).
    let drainsAtBody: { id: string; types: string[] }[] | undefined
    let bodies = 0
    parentRegistry.register({
      name: "read", description: "", inputSchema: {},
      execute: async () => {
        bodies += 1
        drainsAtBody = coordinator.flushed.map((f) => ({ ...f, types: [...f.types] }))
        return { ok: true }
      },
    })
    const mock = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: {} }] },
      { role: "assistant", text: "child done" },
    ])
    let settled: (() => void) | undefined
    const runDone = new Promise<void>((resolve) => { settled = resolve })

    const { sessionId } = await spawnChild({
      taskName: "checkpointed",
      message: "read something",
      parentPath: "root",
      parentRegistry,
      parentSession,
      parentCtx: ctx,
      role: roles.get("general")!,
      parentModel: mock,
      resolveModel: noRoleModel,
      jobs,
      table,
      agents: createAgentRegistry(),
      childSessions: { coordinator, parentSessionId: "sess-main" },
      onSettled: () => settled!(),
    })
    await runDone

    // The body DID run (otherwise "no flush before it" would be trivially true).
    expect(bodies).toBe(1)
    // …and by then the child's marker had been DRAINED through the coordinator,
    // under the child's own session id: the checkpoint is the child's, not the
    // parent's, and it covers the marker that recovery reads.
    expect(drainsAtBody).toHaveLength(1)
    expect(drainsAtBody![0]!.id).toBe(sessionId)
    expect(drainsAtBody![0]!.types).toContain("tool/dispatch")
  }, 10_000)

  // M24a (B1): delegationDepth recursion — a child of a depth-1 subagent is
  // depth 2 (resolveChildDepth = parent + 1), not the hardcoded 1.
  it("spawnChild sets delegationDepth = parent depth + 1 (nested delegation)", async () => {
    const coordinator = fakeCoordinator()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    roles.register({ name: "general", description: "d", systemPrompt: "p", tools: [] })
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    // The parent is itself a depth-1 subagent → the child must be depth 2.
    parentSession.header = { delegationDepth: 1, origin: "subagent" }
    // two parent turns so forkTurns("all") has seed content
    parentSession.events.push({ type: "turn/start" }, { type: "user/message", text: "a" }, { type: "assistant/message", text: "b" }, { type: "turn/end" })
    const mock = createMockClient([{ role: "assistant", text: "ok" }])

    const { sessionId } = await spawnChild({
      taskName: "grandchild",
      message: "hi",
      parentPath: "root/helper",
      parentRegistry,
      parentSession,
      parentCtx: ctx,
      role: roles.get("general")!,
      parentModel: mock,
      resolveModel: noRoleModel,
      jobs,
      table,
      agents: createAgentRegistry(),
      childSessions: { coordinator, parentSessionId: "sess-child" },
    })
    expect(sessionId).toMatch(/^child-/)
    expect(coordinator.created[0]).toMatchObject({ sessionId, parentSession: "sess-child", origin: "subagent", seedLength: 4, delegationDepth: 2 })
    const entry = table.get("root/helper/grandchild")
    expect(entry?.session.header).toMatchObject({ parentSession: "sess-child", origin: "subagent", delegationDepth: 2, seedLength: 4 })
  })

  it("without childSessions behaves exactly as today (anonymous session, no sessionId)", async () => {
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    roles.register({ name: "general", description: "d", systemPrompt: "p", tools: [] })
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    const mock = createMockClient([{ role: "assistant", text: "ok" }])
    const { sessionId, path } = await spawnChild({
      taskName: "h", message: "hi", parentPath: "root",
      parentRegistry, parentSession, parentCtx: ctx, role: roles.get("general")!,
      parentModel: mock, resolveModel: noRoleModel, jobs, table,
      agents: createAgentRegistry(),
    })
    expect(sessionId).toBeUndefined()
    expect(path).toBe("root/h")
    expect(table.get("root/h")?.sessionId).toBeUndefined()
  })
})

describe("spawnChild onSettled seam (M26-D1)", () => {
  it("fires onSettled after a completed initial run with finalText", async () => {
    const ctx = createContext()
    const parentReg = createToolRegistry(ctx)
    parentReg.register(makeTool("read"))
    const roles = createRoleRegistry()
    roles.register({ name: "general", description: "d", systemPrompt: "p", tools: [] })
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const settled: { finalText?: string; error?: string; aborted: boolean }[] = []
    const { path } = await spawnChild({
      taskName: "helper", message: "hi", parentPath: "root", parentRegistry: parentReg,
      parentSession: createSession(), parentCtx: ctx, role: roles.get("general")!,
      parentModel: model, resolveModel: noRoleModel, jobs, table,
      agents: createAgentRegistry(),
      onSettled: (info) => { settled.push(info) },
    })
    expect(path).toBe("root/helper")
    await new Promise((r) => setTimeout(r, 150))
    expect(settled).toHaveLength(1)
    expect(settled[0]).toEqual({ finalText: "ok", aborted: false })
  }, 10_000)
})

// ------------------------------------------------------------------ M49 Task 14 (spec §11): subagent prompt contract

import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { composeSubagentPrompt } from "../src/child.ts"

describe("composeSubagentPrompt (spec §11 — subagent contract)", () => {
  it("appends the contract AFTER the role prompt (role first, human first note last)", () => {
    const p = composeSubagentPrompt("You are a worker agent.")
    expect(p).toContain("You are a worker agent.")
    expect(p).toContain("Subagent contract")
    expect(p).toContain("task scope")
    expect(p).toContain("do not delegate recursively")
    expect(p).toContain("changed files")
    expect(p).toContain("tests")
    expect(p).toContain("result")
    expect(p).toContain("higher priority")
    expect(p.indexOf("You are a worker agent.")).toBeLessThan(p.indexOf("Subagent contract"))
  })
})

describe("spawnChild — M49 Default prompt carries the subagent contract", () => {
  /** Real ModelClient double recording every LLMRequest (the child inherits
   * the parent's client when the role names no model). */
  function recordingModel(): ModelClient & { requests: LLMRequest[] } {
    const requests: LLMRequest[] = []
    return {
      requests,
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        requests.push(request)
        yield { type: "text/chunk", text: "child done" }
        yield { type: "end" }
      },
    }
  }

  it("the child's system prompt = role prompt + subagent contract", async () => {
    const parentCtx = createContext()
    const parentReg = createToolRegistry(parentCtx)
    parentReg.register(makeTool("read"))
    const parentSession = createSession()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    for (const r of builtinRoles()) roles.register(r)
    const model = recordingModel()
    const { jobId } = await spawnChild({
      taskName: "helper",
      message: "do the thing",
      parentPath: "root",
      parentRegistry: parentReg,
      parentSession,
      parentCtx,
      role: roles.get("general")!,
      parentModel: model,
      resolveModel: noRoleModel,
      jobs,
      table,
      agents: createAgentRegistry(),
    })
    for (let i = 0; i < 100 && model.requests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(model.requests.length).toBe(1)
    const prompt = model.requests[0]!.systemPrompt
    expect(prompt).toContain("You are a general-purpose coding agent.")
    expect(prompt).toContain("Subagent contract")
    expect(prompt).toContain("do not delegate recursively")
    expect(prompt).toContain("changed files")
    expect(prompt).toContain("higher priority")
    expect(prompt.indexOf("You are a general-purpose coding agent.")).toBeLessThan(prompt.indexOf("Subagent contract"))
    // the run settles normally with the recording model
    for (let i = 0; i < 200 && jobs.read(jobId)?.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(jobs.read(jobId)?.status).toBe("completed")
  }, 15_000)
})

// ── resolveRoleTools: a role's declared tools vs the HOST's registry ────────
// `role.tools` is a RESTRICTION — the child gets exactly these and no others —
// and it resolves against whatever tools the host mounted. The two vocabularies
// do not agree: this repo registers `read`/`glob`/`grep`, while Claude Code
// plugins declare `Read`/`Glob`/`Grep`. An unmatched name used to be dropped in
// place (`if (tool)` with no else), so the child ran with fewer tools than its
// role declared and no surface reported it.
describe("resolveRoleTools", () => {
  it("registers what the host mounts, returns what it does not, and warns", () => {
    const parent = createToolRegistry(createContext())
    parent.register(makeTool("read"))
    parent.register(makeTool("bash"))
    const child = createToolRegistry(createContext())

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const missing = resolveRoleTools("plugin-agent", ["read", "bash", "Read", "NotebookRead"], parent, child)

      // the two mounted names land...
      expect(child.get("read")).toBeDefined()
      expect(child.get("bash")).toBeDefined()
      // ...the two that resolve to nothing are RETURNED, not silently skipped
      expect(missing).toEqual(["Read", "NotebookRead"])
      expect(child.get("Read")).toBeUndefined()
      expect(child.get("NotebookRead")).toBeUndefined()
      // ...and the drop reached a surface
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0]![0])
      expect(line).toContain("plugin-agent")
      expect(line).toContain("Read")
      expect(line).toContain("NotebookRead")
    } finally {
      warn.mockRestore()
    }
  })

  it("says nothing when every declared tool resolves (the builtin-role case)", () => {
    const parent = createToolRegistry(createContext())
    parent.register(makeTool("read"))
    const child = createToolRegistry(createContext())
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(resolveRoleTools("general", ["read"], parent, child)).toEqual([])
      expect(child.get("read")).toBeDefined()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

/** Two describes share these: the effort test (below) and the budget test
 * (M73). The body is UNCHANGED from where it was declared inside the effort
 * describe — a move, not a second copy. (`recordingModel` at :330 is an
 * earlier twin with a different shape; this task does not touch it.) */
/** A ModelClient that RECORDS every LLMRequest it is asked to serve; the
 * mock client does not, and the request is the only surface where "the child
 * runs at effort X" is a fact rather than a claim. */
function recordingClient(text: string): ModelClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = []
  return {
    requests,
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      requests.push(request)
      yield { type: "text/chunk", text }
      yield { type: "end" }
    },
  }
}

async function settled(jobs: ReturnType<typeof createJobRegistry>, jobId: string): Promise<void> {
  for (let i = 0; i < 200 && jobs.read(jobId).status !== "completed"; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(jobs.read(jobId).status).toBe("completed")
}

/** Module scope (not a describe-local): the role-model cases and the
 * settings/toggle cases below spawn through the SAME fixture. */
function spawnFixture() {
  const parentCtx = createContext()
  const parentReg = createToolRegistry(parentCtx)
  parentReg.register(makeTool("read"))
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  return {
    parentCtx, parentReg, roles,
    parentSession: createSession(),
    jobs: createJobRegistry(),
    table: createAgentTable(),
    agents: createAgentRegistry(),
    parentModel: createMockClient([{ role: "assistant", text: "parent" }]),
  }
}

describe("a role's model goes through the host's resolver (not a registry)", () => {
  it("calls the resolver with the ROLE's selection and uses its client", async () => {
    const f = spawnFixture()
    const roleClient = createMockClient([{ role: "assistant", text: "from the role's model" }])
    const calls: Array<{ provider: string; model: string }> = []
    const resolveModel = async (sel: { provider: string; model: string }) => {
      calls.push(sel)
      return {
        status: "ready" as const,
        binding: { client: roleClient, providerId: sel.provider, modelId: sel.model, label: "role" },
      }
    }

    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: { ...f.roles.get("general")!, model: { provider: "gw", model: "small" } },
      parentModel: f.parentModel, resolveModel,
      // A role that names a model is gated by `plugins.subagentModel` (the case
      // below); this case is about the RESOLVER, so it turns the gate on.
      allowSubagentModelSelection: true,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })

    expect(calls).toEqual([{ provider: "gw", model: "small" }])
    // The resolved client is not merely REACHED — it is what the child RAN on.
    // Without this the task is unasserted: resolving and then discarding the
    // binding (keeping `opts.parentModel`) would pass every other case here,
    // because the parent's mock answers too — just with the wrong text.
    for (let i = 0; i < 200 && f.jobs.read(jobId).status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(f.jobs.read(jobId).output).toBe("from the role's model")
    // the spawn RECORDS what it resolved, so a later read cannot disagree with it
    expect(f.table.get("root/helper")?.modelLabel).toBe("gw:small")
  }, 10_000)

  it("a resolver that is not ready FAILS the spawn with the resolver's reason", async () => {
    const f = spawnFixture()
    const resolveModel = async () => ({ status: "invalid" as const, reason: 'Unknown provider "gw"' })

    await expect(spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: { ...f.roles.get("general")!, model: { provider: "gw", model: "small" } },
      parentModel: f.parentModel, resolveModel,
      allowSubagentModelSelection: true,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })).rejects.toThrow(/Unknown provider "gw"/)
  })

  it("a role with NO model never calls the resolver — it inherits the parent's client", async () => {
    const f = spawnFixture()
    let called = 0
    const resolveModel = async () => { called += 1; return { status: "unconfigured" as const, reason: "x" } }

    await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: f.roles.get("general")!,
      parentModel: f.parentModel, resolveModel,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })

    expect(called).toBe(0)
  })
})

// ── The role's model, from settings, behind `plugins.subagentModel` ─────────
// `plugins.subagentModel` (settings, default false) is the switch that lets a
// role run on a model of its own at all. It shipped with the schema and had NO
// reader until this seam. The rule, in order: the HOST's `agents.roles.<name>`
// entry, else the role's own declaration, else inherit the parent's client.
// With the switch off, a role that would run on its own model FAILS instead of
// quietly running on the parent's — a role that names one model and runs
// another is the wrong answer stated as a right one — and the message names
// both fixes.
describe("the role's model: settings beats the role, and the toggle gates both", () => {
  const roleWith = (f: ReturnType<typeof spawnFixture>, model?: { provider: string; model: string }) => ({
    ...f.roles.get("general")!, ...(model !== undefined ? { model } : {}),
  })
  const spyResolver = () => {
    const calls: Array<{ provider: string; model: string }> = []
    return {
      calls,
      resolveModel: async (sel: { provider: string; model: string }) => {
        calls.push(sel)
        return { status: "ready" as const, binding: { client: createMockClient([]), providerId: sel.provider, modelId: sel.model, label: "role" } }
      },
    }
  }
  // The brief's `Record<string, unknown>` for `opts` cannot typecheck: spreading
  // an index-signature type drops the fields it supplies — `role` and
  // `resolveModel` become `unknown` — and tsc rejects the call. These two are
  // required and the rest override the fixture, which is the same thing the
  // brief's cases pass. Same values, checked.
  type SpawnOverrides = Pick<SpawnOptions, "role" | "resolveModel"> & Partial<Omit<SpawnOptions, "role" | "resolveModel">>
  const spawnWith = (f: ReturnType<typeof spawnFixture>, opts: SpawnOverrides) => spawnChild({
    taskName: "helper", message: "do the thing", parentPath: "root",
    parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
    parentModel: f.parentModel, jobs: f.jobs, table: f.table, agents: f.agents,
    ...opts,
  })

  it("toggle OFF + a role that declares a model → the spawn FAILS, naming both fixes", async () => {
    const f = spawnFixture()
    const { resolveModel } = spyResolver()

    await expect(spawnWith(f, {
      role: roleWith(f, { provider: "gw", model: "small" }),
      resolveModel, allowSubagentModelSelection: false,
    })).rejects.toThrow(/plugins\.subagentModel/)
  })

  it("toggle OFF + a role with NO model → inherit, unchanged from today", async () => {
    const f = spawnFixture()
    const { calls, resolveModel } = spyResolver()

    await spawnWith(f, { role: roleWith(f), resolveModel, allowSubagentModelSelection: false })

    expect(calls).toEqual([])
  })

  // The refusal offers TWO repairs, and the second must be one the CLI can
  // actually perform: `roles unset` accepts only the four built-in names, so
  // naming it for a plugin-contributed role or the guardian's `reviewer` sent
  // the reader to a command that exits 1 with "unknown role".
  it("names a repair that works for the name's kind", async () => {
    const f = spawnFixture()
    const { resolveModel } = spyResolver()
    const refusal = (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: Error) => e.message)

    const builtin = await refusal(spawnWith(f, {
      role: roleWith(f, { provider: "gw", model: "small" }), resolveModel,
    }))
    expect(builtin).toContain("`i-harness roles unset general`")

    const f2 = spawnFixture()
    const other = await refusal(spawnWith(f2, {
      role: { ...f2.roles.get("general")!, name: "reviewer", model: { provider: "gw", model: "small" } },
      resolveModel,
    }))
    expect(other).toContain("`agents.roles.reviewer` in settings.json")
    expect(other).not.toContain("roles unset")
  })

  it("an ABSENT toggle is OFF, not enabled — the same refusal, and the resolver is never reached", async () => {
    const f = spawnFixture()
    const { calls, resolveModel } = spyResolver()

    await expect(spawnWith(f, {
      role: roleWith(f, { provider: "gw", model: "small" }),
      resolveModel,
    })).rejects.toThrow(/plugins\.subagentModel/)
    // Refused BEFORE the resolver: a refusal that resolved first would still
    // have built a client for a model the host did not enable.
    expect(calls).toEqual([])
  })

  it("toggle ON → SETTINGS beat the role's own declaration", async () => {
    const f = spawnFixture()
    const { calls, resolveModel } = spyResolver()

    await spawnWith(f, {
      role: roleWith(f, { provider: "gw", model: "from-role" }),
      resolveModel, allowSubagentModelSelection: true,
      roleSelectionFor: () => ({ provider: "gw", model: "from-settings" }),
    })

    expect(calls).toEqual([{ provider: "gw", model: "from-settings" }])
  })

  it("toggle ON + no settings entry → the role's own declaration", async () => {
    const f = spawnFixture()
    const { calls, resolveModel } = spyResolver()

    await spawnWith(f, {
      role: roleWith(f, { provider: "gw", model: "from-role" }),
      resolveModel, allowSubagentModelSelection: true,
      roleSelectionFor: () => undefined,
    })

    expect(calls).toEqual([{ provider: "gw", model: "from-role" }])
  })
})

// ── the resolved binding's reasoningEffort is HANDED TO THE CHILD ───────────
// `roles set worker --provider gw --model big --reasoning-effort max` prints the
// effort, and the runtime VALIDATES it (provider-runtime refuses a bad one) —
// but the child used to run at the adapter default, because the resolution kept
// `binding.client` and dropped the rest. A declared setting that does nothing is
// the defect class this section exists to end, so the child's own LLMRequest is
// what gets asserted, not the resolver's return value.
describe("the role's resolved reasoningEffort reaches the child", () => {
  it("copies a resolved effort onto the child's request", async () => {
    const f = spawnFixture()
    const roleClient = recordingClient("from the role's model")
    const resolveModel = async () => ({
      status: "ready" as const,
      binding: { client: roleClient, providerId: "gw", modelId: "big", label: "role", reasoningEffort: "high" as const },
    })

    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: { ...f.roles.get("general")!, model: { provider: "gw", model: "big" } },
      parentModel: f.parentModel, resolveModel,
      allowSubagentModelSelection: true,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    await settled(f.jobs, jobId)

    expect(roleClient.requests).toHaveLength(1)
    expect(roleClient.requests[0]!.reasoningEffort).toBe("high")
  }, 10_000)

  it("sends NONE when the resolved binding carries none", async () => {
    const f = spawnFixture()
    const roleClient = recordingClient("from the role's model")
    const resolveModel = async () => ({
      status: "ready" as const,
      binding: { client: roleClient, providerId: "gw", modelId: "big", label: "role" },
    })

    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: { ...f.roles.get("general")!, model: { provider: "gw", model: "big" } },
      parentModel: f.parentModel, resolveModel,
      allowSubagentModelSelection: true,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    await settled(f.jobs, jobId)

    expect(roleClient.requests).toHaveLength(1)
    expect(roleClient.requests[0]).not.toHaveProperty("reasoningEffort")
  }, 10_000)
})

// ── the child's request carries the SESSION's budget, not just its model ─────
// provider-runtime's binding already carries `contextWindow`/`maxOutputTokens`;
// the spawn kept the client and the effort and dropped those two, so every child
// ran unbounded — a request with no cap is one nothing can clamp (on anthropic
// the adapter's own 128k fallback, unclamped, is what reaches the wire) and a
// request with no window is one the budget ladder cannot even measure. The
// REQUEST is the surface where "the child carries its budget" is a fact.
describe("the child's request carries the resolved budget", () => {
  it("a declared role's binding hands its window and cap to the child", async () => {
    const f = spawnFixture()
    const roleClient = recordingClient("from the role's model")
    const resolveModel = async () => ({
      status: "ready" as const,
      binding: {
        client: roleClient, providerId: "gw", modelId: "big", label: "role",
        contextWindow: 9_000, maxOutputTokens: 50_000,
      },
    })
    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: { ...f.roles.get("general")!, model: { provider: "gw", model: "big" } },
      parentModel: f.parentModel, resolveModel,
      allowSubagentModelSelection: true,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    await settled(f.jobs, jobId)

    const req = roleClient.requests[0]!
    // 9k window, 50k cap ⇒ the clamp MUST have shrunk it. This is the assertion
    // that fails if the WINDOW was dropped: clampOutputCap returns the value
    // untouched when the window is undefined (llm-seam), so a cap-only fix
    // would sail through an equality assertion on 50_000 and leave the 400
    // this unit exists to close.
    expect(req.maxOutputTokens).toBeGreaterThan(0)
    expect(req.maxOutputTokens!).toBeLessThan(50_000)
  }, 10_000)

  it("an inheriting child gets the SESSION's numbers", async () => {
    const f = spawnFixture()
    const parentClient = recordingClient("parent")
    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: f.roles.get("general")!,        // no role model → the inherit arm
      parentModel: parentClient, resolveModel: noRoleModel,
      contextWindow: 200_000, maxOutputTokens: 4_242,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    await settled(f.jobs, jobId)

    // 200k window vs a small request ⇒ the clamp is a no-op and the value is
    // the session's own, verbatim.
    expect(parentClient.requests[0]!.maxOutputTokens).toBe(4_242)
  }, 10_000)

  it("neither source has one → the child's request carries NEITHER key", async () => {
    const f = spawnFixture()
    const parentClient = recordingClient("parent")
    const { jobId } = await spawnChild({
      taskName: "helper", message: "do the thing", parentPath: "root",
      parentRegistry: f.parentReg, parentSession: f.parentSession, parentCtx: f.parentCtx,
      role: f.roles.get("general")!,
      parentModel: parentClient, resolveModel: noRoleModel,
      jobs: f.jobs, table: f.table, agents: f.agents,
    })
    await settled(f.jobs, jobId)

    // 缺席即缺席 — a spawned default here would be a number nobody chose.
    expect("maxOutputTokens" in parentClient.requests[0]!).toBe(false)
  }, 10_000)
})
