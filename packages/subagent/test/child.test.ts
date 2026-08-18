import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, type SessionEvent } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import { createMockClient } from "@i-harness/llm-mock"
import { createJobRegistry } from "../src/jobs.ts"
import { createRoleRegistry, builtinRoles } from "../src/roles.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { forkTurns } from "../src/fork.ts"
import { spawnChild } from "../src/child.ts"
import { createProviderRegistry } from "@i-harness/provider"

function makeTool(name: string): Tool {
  return { name, description: "", inputSchema: {}, execute: async () => ({}) }
}

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
    const providers = createProviderRegistry()
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
      providers,
      jobs,
      table,
    })
    expect(path).toBe("root/helper")
    expect(jobId).toMatch(/^subagent-\d+$/)
    expect(table.get("root/helper")!.status).toBe("running")
    await new Promise((r) => setTimeout(r, 150))
    expect(table.get("root/helper")!.status).toBe("completed")
    expect(jobs.read(jobId).status).toBe("completed")
  }, 10_000)
})

function fakeCoordinator(): SessionCoordinator & { created: SessionMeta[]; enqueued: { id: string; events: unknown[] }[] } {
  const created: SessionMeta[] = []
  const enqueued: { id: string; events: unknown[] }[] = []
  return {
    created,
    enqueued,
    async create(meta) {
      created.push(meta as SessionMeta)
      return { id: (meta as { sessionId?: string }).sessionId ?? "sess-x" }
    },
    async append() {},
    enqueue(id, events) { enqueued.push({ id, events: [...events] }) },
    async load() { return { session: { formatVersion: 1, events: [] } } },
    async list() { return [] },
    async flush() {},
    async close() {},
    async putDocument() {},
    async getDocument() { return undefined },
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

    const { path, sessionId } = await spawnChild({
      taskName: "helper",
      message: "hi",
      parentPath: "root",
      parentRegistry,
      parentSession,
      parentCtx: ctx,
      role: roles.get("general")!,
      parentModel: mock,
      providers: createProviderRegistry(),
      jobs,
      table,
      childSessions: { coordinator, parentSessionId: "sess-main" },
    })
    expect(sessionId).toMatch(/^child-/)
    expect(path).toBe("root/helper")
    expect(coordinator.created).toHaveLength(1)
    expect(coordinator.created[0]).toMatchObject({ sessionId, parentSession: "sess-main", origin: "subagent", seedLength: 4, delegationDepth: 0 })
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
    expect(entry?.session.header).toMatchObject({ parentSession: "sess-main", origin: "subagent", delegationDepth: 0, seedLength: 4 })
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
      parentModel: mock, providers: createProviderRegistry(), jobs, table,
    })
    expect(sessionId).toBeUndefined()
    expect(path).toBe("root/h")
    expect(table.get("root/h")?.sessionId).toBeUndefined()
  })
})
