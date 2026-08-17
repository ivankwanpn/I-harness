import { describe, expect, it } from "vitest"
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
      return { version: f.meta.formatVersion, events: f.events }
    },
    async list() { return [...files.keys()] },
    async repair(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { version: f.meta.formatVersion, events: f.events }
    },
    async putDocument(key, data) { documents.set(key, data) },
    async getDocument(key) { return documents.get(key) },
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

  it("flush resolves (append batches already fsync at the backend)", async () => {
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
