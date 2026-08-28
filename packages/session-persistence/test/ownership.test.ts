import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireSessionLock, lockPathFor, SessionLockConflictError } from "@i-harness/fs-lock"
import type { SessionEvent } from "@i-harness/core-session"
import {
  createSessionCoordinator,
  type CoordinatorOptions,
  type PersistenceBackend,
  type SessionCoordinator,
  type SessionMeta,
} from "../src/index.ts"

// In-memory fake backend (same shape as persistence.test.ts's fakeBackend) so
// the lease logic is tested without disk I/O. The instance is shared between
// coordinators within a test to simulate one shared store; exclusivity comes
// from the shared lockRoot, not from the fake.
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
  }
}

// Short acquire retry/deadline so conflict tests fail fast.
const FAST = { acquireRetryMs: 2, acquireDeadlineMs: 40 }

let root: string
const coordinators: SessionCoordinator[] = []
const tracked = (backend: PersistenceBackend, opts: CoordinatorOptions = {}): SessionCoordinator => {
  const c = createSessionCoordinator(backend, opts)
  coordinators.push(c)
  return c
}
// Every lease must be gone before afterAll removes the tmp lock root.
afterEach(async () => {
  for (const c of coordinators.splice(0)) await c.close()
})

describe("session ownership lease", () => {
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "i-harness-owner-")) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("lock defaults to disabled — two writers on one session do not conflict (M23-P2 opt-in)", async () => {
    const shared = fakeBackend()
    const a = tracked(shared)
    const b = tracked(shared)
    const { id } = await a.create({ sessionId: "sess-off" })
    expect(a.ownerOf(id)).toBe(false)
    const second = await b.create({ sessionId: "sess-off" })
    expect(second.id).toBe(id)
    expect(b.ownerOf(id)).toBe(false)
  })

  describe.skipIf(process.platform !== "win32")("opt-in lease (win32 real locks)", () => {
    it("create acquires ownership; second coordinator on the same session conflicts (acquire-at-live)", async () => {
      const shared = fakeBackend()
      const a = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      const { id } = await a.create({ sessionId: "sess-ownership-1" })
      expect(a.ownerOf(id)).toBe(true)
      // 2nd coordinator, same lockRoot → conflict on create (fail-closed, no queueing)
      const b = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      await expect(b.create({ sessionId: "sess-ownership-1" })).rejects.toThrow(SessionLockConflictError)
      expect(b.ownerOf("sess-ownership-1")).toBe(false)
      await a.close()
      // after close releases the lease, another coordinator can own the session
      const b2 = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      const b2r = await b2.create({ sessionId: "sess-ownership-1" })
      expect(b2r.id).toBe("sess-ownership-1")
      expect(b2.ownerOf("sess-ownership-1")).toBe(true)
    })

    it("append is acquire-at-first-use and conflicts while another coordinator owns the session", async () => {
      const shared = fakeBackend()
      const a = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      const { id } = await a.create({ sessionId: "sess-append" })
      const b = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      await expect(b.append(id, [{ type: "turn/start" }])).rejects.toThrow(SessionLockConflictError)
      // the owner keeps writing
      await a.append(id, [{ type: "turn/start" }])
    })

    it("enqueue keeps its synchronous surface; the write callback acquires and the conflict fails the flush (M23-P4)", async () => {
      const shared = fakeBackend()
      const a = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      const { id } = await a.create({ sessionId: "sess-enqueue" })
      const b = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      expect(() => b.enqueue(id, [{ type: "turn/start" }])).not.toThrow() // enqueue stays sync
      await expect(b.flush(id)).rejects.toThrow(SessionLockConflictError)
      expect(b.ownerOf(id)).toBe(false)
    })

    it("enqueue conflict is retained and reported via reportBackgroundFailure", async () => {
      const shared = fakeBackend()
      const a = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      const { id } = await a.create({ sessionId: "sess-bg" })
      const report = vi.fn()
      const b = tracked(shared, {
        lock: { enabled: true, lockRoot: root },
        maxDelayMs: 5,
        ...FAST,
        reportBackgroundFailure: report,
      })
      b.enqueue(id, [{ type: "turn/start" }])
      await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1), { timeout: 2000 })
      expect(report.mock.calls[0]![0]).toBeInstanceOf(SessionLockConflictError)
      expect(b.ownerOf(id)).toBe(false)
    })

    it("load borrows the lease only around repair (repair guard): conflicts under another writer, never held long-term", async () => {
      const shared = fakeBackend()
      const a = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      const { id } = await a.create({ sessionId: "sess-load" })
      // live session: the coordinator's own lease is reused — load neither
      // re-acquires nor releases it
      await a.load(id)
      expect(a.ownerOf(id)).toBe(true)
      const b = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      await expect(b.load(id)).rejects.toThrow(SessionLockConflictError) // repair is mutating → guard
      await a.close()
      const { session } = await b.load(id) // borrowed for repair, released after
      expect(session.events).toEqual([])
      expect(b.ownerOf(id)).toBe(false)
    })

    it("adoptOwnership holds long-term after load until close; conflicts while another writer owns", async () => {
      const shared = fakeBackend()
      const a = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      const { id } = await a.create({ sessionId: "sess-adopt" })
      const b = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      await expect(b.adoptOwnership(id)).rejects.toThrow(SessionLockConflictError)
      await a.close()
      await b.adoptOwnership(id) // CLI resume path: hold until close
      expect(b.ownerOf(id)).toBe(true)
      await b.close()
      expect(b.ownerOf(id)).toBe(false)
    })

    // I1: concurrent mutating calls for the SAME session on ONE coordinator
    // must share a single acquireLease flight. Before single-flight, the two
    // concurrent acquires raced each other at the OS level (process-level
    // exclusive lock) — the loser hit the retry deadline and the coordinator
    // threw SessionLockConflictError against itself.
    it("I1 single-flight: two concurrent appends to a fresh session both succeed (no self-conflict)", async () => {
      const shared = fakeBackend()
      const seed = tracked(shared) // lock-disabled: only seeds the store record
      const id = "sess-i1-race"
      await seed.create({ sessionId: id })
      const a = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      await expect(Promise.all([
        a.append(id, [{ type: "turn/start" }]),
        a.append(id, [{ type: "turn/start" }]),
      ])).resolves.toBeDefined()
      expect(a.ownerOf(id)).toBe(true) // exactly one lease, held live
      await a.append(id, [{ type: "step/start" }]) // ownership keeps working
    })

    // I1 × borrow: load's borrow must never "borrow" (and later release) a
    // lease that a concurrent mutating path's in-flight acquire is seeding —
    // the shared flight belongs to the seeding caller (adopt here).
    it("I1 borrow guard: concurrent adopt + load keep the adopt's lease (no cross-release)", async () => {
      const shared = fakeBackend()
      const seed = tracked(shared)
      const id = "sess-i1-borrow"
      await seed.create({ sessionId: id })
      const a = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      // adopt seeds the single-flight acquire synchronously; load's borrow
      // joins it and must come back borrowed=false (observe, don't release).
      await Promise.all([a.adoptOwnership(id), a.load(id)])
      expect(a.ownerOf(id)).toBe(true)
    })

    // M1: close() must attempt EVERY held lease's release (all-settled shape)
    // and always clear the map. Note: the sync-throw path inside release() is
    // defensive hardening — fs-lock's real release only throws on OS unlock
    // failure, which cannot be forced cleanly here — so this test guards the
    // observable contract (multi-lease close releases all, no rejection)
    // rather than the throw path itself.
    it("M1: close() with multiple held leases releases every one of them", async () => {
      const shared = fakeBackend()
      const a = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      await a.create({ sessionId: "sess-m1-a" })
      await a.create({ sessionId: "sess-m1-b" })
      expect(a.ownerOf("sess-m1-a")).toBe(true)
      expect(a.ownerOf("sess-m1-b")).toBe(true)
      await a.close()
      expect(a.ownerOf("sess-m1-a")).toBe(false)
      expect(a.ownerOf("sess-m1-b")).toBe(false)
      // OS-level proof both leases are gone: fresh coordinators can take them
      const b = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      await b.adoptOwnership("sess-m1-a")
      await b.adoptOwnership("sess-m1-b")
    })

    // M2: create takes the lease BEFORE the store write (acquire-at-live), so
    // a failing backend.create must not strand the lease on a session that
    // was never created — fail-closed means fail-clean.
    it("M2: a failed create releases the lease it took (ownerOf false, OS lease free)", async () => {
      const shared = fakeBackend()
      const boom = new Error("EEXIST: duplicate create (simulated)")
      const failing: PersistenceBackend = { ...shared, async create() { throw boom } }
      const a = tracked(failing, { lock: { enabled: true, lockRoot: root }, ...FAST })
      await expect(a.create({ sessionId: "sess-m2" })).rejects.toThrow(boom)
      expect(a.ownerOf("sess-m2")).toBe(false)
      // OS-level proof the lease was truly released (not just dropped from
      // the map): another coordinator can acquire it.
      const b = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST })
      await b.adoptOwnership("sess-m2")
      expect(b.ownerOf("sess-m2")).toBe(true)
    })

    // M2 precision: only a lease acquired by THIS create call is released on
    // failure — a duplicate create on an already-owned session keeps the
    // pre-existing (live) lease.
    it("M2 precision: failed duplicate create keeps the already-owned lease", async () => {
      const shared = fakeBackend()
      let failCreate = false
      const flaky: PersistenceBackend = {
        ...shared,
        async create(sessionId, meta) {
          if (failCreate) throw new Error("EEXIST: duplicate create (simulated)")
          return shared.create(sessionId, meta)
        },
      }
      const a = tracked(flaky, { lock: { enabled: true, lockRoot: root }, ...FAST })
      const { id } = await a.create({ sessionId: "sess-m2-keep" })
      expect(a.ownerOf(id)).toBe(true)
      failCreate = true
      await expect(a.create({ sessionId: id })).rejects.toThrow()
      expect(a.ownerOf(id)).toBe(true) // the live lease survives the failed re-create
    })

    it("putDocument is fail-closed — a conflicting doc lease skips the write and reports it", async () => {
      const shared = fakeBackend()
      const report = vi.fn()
      const c = tracked(shared, { lock: { enabled: true, lockRoot: root }, ...FAST, reportBackgroundFailure: report })
      const key = "ownership-doc"
      const docLock = await acquireSessionLock({ lockPath: lockPathFor(root, `doc:${key}`), retryMs: 2, deadlineMs: 40 })
      try {
        await c.putDocument(key, { hello: true }) // never rejects (M6 contract); reports instead
        expect(report).toHaveBeenCalledTimes(1)
        expect(report.mock.calls[0]![0]).toBeInstanceOf(SessionLockConflictError)
        expect(await c.getDocument(key)).toBeUndefined() // fail-closed: nothing was written
      } finally {
        await docLock.release()
      }
    })
  })
})
