import { describe, expect, it, vi } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import {
  createSessionCoordinator,
  registerUpgrade,
  SessionFormatUnsupportedError,
  type PersistenceBackend,
  type SessionMeta,
} from "../src/index.ts"

// In-memory fake backend so coordinator logic is tested without disk I/O.
function fakeBackend(): PersistenceBackend {
  const files = new Map<string, { meta: SessionMeta; events: SessionEvent[] }>()
  const documents = new Map<string, unknown>()
  return {
    id: "jsonl",
    capabilities: { seekableRead: false, rawArtifacts: true },
    async create(sessionId, meta) { files.set(sessionId, { meta, events: [] }) },
    async append(sessionId, events) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      f.events.push(...events)
    },
    async read(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { version: f.meta.formatVersion, events: f.events, meta: f.meta }
    },
    async list() { return [...files.keys()] },
    async repair(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { version: f.meta.formatVersion, events: f.events, meta: f.meta }
    },
    async putDocument(key, data) { documents.set(key, data) },
    async getDocument(key) { return documents.get(key) },
    async profile(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { meta: f.meta, blank: f.events.every((ev) => ev.type !== "turn/start") }
    },
    async updateMeta(sessionId, patch) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      f.meta = { ...f.meta, ...patch }
      return f.meta
    },
  }
}

describe("session coordinator", () => {
  it("create generates an id and writes the header via the backend", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create()
    expect(id).toMatch(/^sess-/)
    expect(await backend.list()).toEqual([id])
  })

  it("append then load round-trips events into a Session", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create()
    await coordinator.append(id, [{ type: "turn/start" }, { type: "user/message", text: "hi" }])
    const { session } = await coordinator.load(id)
    expect(session.formatVersion).toBe(1)
    expect(session.events).toMatchObject([{ type: "turn/start" }, { type: "user/message", text: "hi" }])
  })

  it("applies registered upgrades in order (migrate-on-continue)", async () => {
    registerUpgrade(0, (events) =>
      events.map((e) => (e.type === "turn/start" ? { type: "turn/start", migrated: true } : e)),
    )
    const backend = fakeBackend()
    await backend.create("old", { formatVersion: 0, sessionId: "old", createdAt: "x" })
    await backend.append("old", [{ type: "turn/start" }])
    const coordinator = createSessionCoordinator(backend)
    const { session } = await coordinator.load("old")
    expect(session.formatVersion).toBe(1)
    expect(session.events[0]).toMatchObject({ type: "turn/start", migrated: true })
  })

  it("refuses a version with no upgrade path", async () => {
    const backend = fakeBackend()
    await backend.create("future", { formatVersion: 99, sessionId: "future", createdAt: "x" })
    await backend.append("future", [{ type: "turn/start" }])
    const coordinator = createSessionCoordinator(backend)
    await expect(coordinator.load("future")).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
  })

  // F01-7: refusal must fire BEFORE the backend's repair can structurally
  // decode + rewrite a foreign-version file. The gate reads via the
  // non-destructive `read`, so `repair` (which may mutate) is never reached.
  it("refuses an unsupported version BEFORE repair runs (no file mutation)", async () => {
    let repairCalled = false
    const backend: PersistenceBackend = {
      id: "jsonl",
      capabilities: { seekableRead: false, rawArtifacts: true },
      async create() {},
      async append() {},
      async read() { return { version: 99, events: [] } },
      async list() { return [] },
      async repair() { repairCalled = true; return { version: 99, events: [] } },
      async putDocument() {},
      async getDocument() { return undefined },
      async profile() { throw new Error("unused") },
      async updateMeta() { throw new Error("unused") },
    }
    const coordinator = createSessionCoordinator(backend)
    await expect(coordinator.load("future")).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    expect(repairCalled).toBe(false)
  })

  it("ignorable guard: unknown type without marker refuses; with marker is dropped", async () => {
    const backend = fakeBackend()
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "x" })
    await backend.append("s1", [
      { type: "turn/start" },
      { type: "future/thing", payload: "x", ignorable: true } as unknown as SessionEvent,
      { type: "turn/end" },
    ])
    const coordinator = createSessionCoordinator(backend)
    const { session } = await coordinator.load("s1")
    expect(session.events.map((e) => e.type)).toEqual(["turn/start", "turn/end"])

    await backend.append("s1", [{ type: "bad/thing" } as unknown as SessionEvent])
    await expect(coordinator.load("s1")).rejects.toThrow(/unknown event type/i)
  })

  it("M20 compaction/reset marker crosses the load gate (registered event type)", async () => {
    const backend = fakeBackend()
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "x" })
    await backend.append("s1", [
      { type: "turn/start" },
      { type: "compaction/reset", removedSeqs: [] },
      { type: "user/message", text: "hi" },
    ] as SessionEvent[])
    const coordinator = createSessionCoordinator(backend)
    const { session } = await coordinator.load("s1")
    expect(session.events.map((e) => e.type)).toEqual(["turn/start", "compaction/reset", "user/message"])
  })

  it("flush on a session with no write-behind resolves (no pending writes)", async () => {
    const coordinator = createSessionCoordinator(fakeBackend())
    const { id } = await coordinator.create()
    await expect(coordinator.flush(id)).resolves.toBeUndefined()
  })
})

describe("session coordinator documents", () => {
  it("putDocument/getDocument round-trips arbitrary data", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const doc = { jobs: [], agentTable: [], roles: [] }
    await coordinator.putDocument("subagent-state", doc)
    expect(await coordinator.getDocument("subagent-state")).toEqual(doc)
    expect(await coordinator.getDocument("missing")).toBeUndefined()
  })
})

describe("session coordinator write-behind (M7)", () => {
  it("enqueue then flush persists events through the backend", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create()
    coordinator.enqueue(id, [{ type: "turn/start" }, { type: "turn/end" }])
    await coordinator.flush(id)
    const { events } = await backend.read(id)
    expect(events).toMatchObject([{ type: "turn/start" }, { type: "turn/end" }])
  })

  it("flush on a session with no write-behind resolves", async () => {
    const coordinator = createSessionCoordinator(fakeBackend())
    await expect(coordinator.flush("sess-none")).resolves.toBeUndefined()
  })

  it("close drains sessions and documents and is idempotent", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create()
    coordinator.enqueue(id, [{ type: "turn/start" }])
    await coordinator.putDocument("k", { a: 1 })
    await coordinator.close()
    await coordinator.close()
    const { events } = await backend.read(id)
    expect(events).toMatchObject([{ type: "turn/start" }])
    expect(await backend.getDocument("k")).toEqual({ a: 1 })
  })

  it("putDocument never rejects and reports background failures", async () => {
    const backend = fakeBackend()
    const report = vi.fn()
    const coordinator = createSessionCoordinator(backend, { reportBackgroundFailure: report })
    const failing = vi.spyOn(backend, "putDocument").mockRejectedValueOnce(new Error("disk"))
    await expect(coordinator.putDocument("k", {})).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledTimes(1)
    expect(failing).toHaveBeenCalledTimes(1)
    // the chain stays alive: the next putDocument still lands
    await coordinator.putDocument("k2", { b: 2 })
    expect(await backend.getDocument("k2")).toEqual({ b: 2 })
  })
})

describe("session coordinator lineage (M8)", () => {
  it("create with a lineage meta persists it and load returns the header", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create({
      sessionId: "child-abc",
      parentSession: "sess-parent",
      seedLength: 3,
      origin: "subagent",
      delegationDepth: 0,
    })
    expect(id).toBe("child-abc")
    const { session } = await coordinator.load(id)
    expect(session.header).toEqual({ parentSession: "sess-parent", seedLength: 3, origin: "subagent", delegationDepth: 0 })
  })

  it("create without a sessionId still generates sess-... and no header", async () => {
    const coordinator = createSessionCoordinator(fakeBackend())
    const { id } = await coordinator.create()
    expect(id).toMatch(/^sess-/)
    const { session } = await coordinator.load(id)
    expect(session.header).toBeUndefined()
  })

  it("load tolerates subagent/inbox events (known type)", async () => {
    const backend = fakeBackend()
    await backend.create("child-abc", { formatVersion: 1, sessionId: "child-abc", createdAt: "x" })
    await backend.append("child-abc", [
      { type: "turn/start" },
      { type: "subagent/inbox", messageId: "m1", message: "ping" },
      { type: "turn/end" },
    ])
    const coordinator = createSessionCoordinator(backend)
    const { session } = await coordinator.load("child-abc")
    expect(session.events.map((e) => e.type)).toContain("subagent/inbox")
  })

  it("load tolerates compaction events (known types), returned intact", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    await coordinator.create({ sessionId: "sess-compacted" })
    await coordinator.append("sess-compacted", [
      { type: "turn/start" },
      { type: "user/message", text: "old work" },
      { type: "compaction/start" },
      { type: "compaction/summary", text: "SUMMARY", shadowedSeqs: [1] },
      { type: "compaction/end" },
      { type: "turn/end" },
    ])
    const { session } = await coordinator.load("sess-compacted")
    expect(session.events.map((e) => e.type)).toEqual([
      "turn/start",
      "user/message",
      "compaction/start",
      "compaction/summary",
      "compaction/end",
      "turn/end",
    ])
    const summary = session.events.find((e) => e.type === "compaction/summary") as { text: string; shadowedSeqs: number[] }
    expect(summary.text).toBe("SUMMARY")
    expect(summary.shadowedSeqs).toEqual([1])
  })
})
