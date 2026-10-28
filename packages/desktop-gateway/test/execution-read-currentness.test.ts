import { expect, it, vi } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import { createDesktopExecution, readDesktopSnapshot } from "../src/execution.ts"
import { recordFixture } from "./managed-fixture.ts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-currentness-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "s" })
  const doc = await coordinator.openManagedDocument("s")
  await recordFixture(doc, { type: "code/cell", cellId: "old", sessionId: "s", state: "started", source: "old source" })
  await recordFixture(doc, { type: "code/cell", cellId: "new", sessionId: "s", state: "completed", source: "new source" })
  await coordinator.flush("s")
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  return { root, coordinator, service, read: createDesktopExecution(coordinator, service).read, async close() { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}
function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

it("rejects a revoked entry before reading or selecting an owner", async () => {
  const f = await fixture(), sentinel = new Error("revoked")
  try {
    const profile = vi.spyOn(f.coordinator, "profile"), snapshot = vi.spyOn(f.coordinator, "snapshot"), owner = vi.spyOn(f.service, "liveAssembly")
    const guard = () => { throw sentinel }
    await expect(f.read("s", {}, guard)).rejects.toBe(sentinel)
    await expect(readDesktopSnapshot(f.coordinator, "s", guard)).rejects.toBe(sentinel)
    expect(profile).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled(); expect(owner).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("rejects after a held real profile even after an ABA label change", async () => {
  const f = await fixture(), held = latch(), entered = latch(), sentinel = new Error("revoked")
  try {
    const original = f.coordinator.profile.bind(f.coordinator)
    vi.spyOn(f.coordinator, "profile").mockImplementation(async id => { const result = await original(id); entered.release(); await held.promise; return result })
    const owner = vi.spyOn(f.service, "liveAssembly"), snapshot = vi.spyOn(f.coordinator, "snapshot")
    let epoch = 0, label = "A"; const captured = epoch
    const result = f.read("s", {}, () => { if (epoch !== captured || label !== "A") throw sentinel })
    await entered.promise; label = "B"; epoch++; label = "A"; epoch++; held.release()
    await expect(result).rejects.toBe(sentinel); expect(owner).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
  } finally { held.release(); await f.close() }
})

it.each(["helper", "read"] as const)("rejects a held real snapshot through %s", async mode => {
  const f = await fixture(), held = latch(), entered = latch(), sentinel = new Error("revoked")
  try {
    const original = f.coordinator.snapshot!.bind(f.coordinator)
    const snapshot = vi.spyOn(f.coordinator as Required<typeof f.coordinator>, "snapshot").mockImplementation(async (id: string) => { const value = await original(id); entered.release(); await held.promise; return value })
    let current = true; const guard = () => { if (!current) throw sentinel }
    const result = mode === "helper" ? readDesktopSnapshot(f.coordinator, "s", guard) : f.read("s", {}, guard)
    await entered.promise; current = false; held.release(); await expect(result).rejects.toBe(sentinel); expect(snapshot).toHaveBeenCalledTimes(1)
  } finally { held.release(); await f.close() }
})

it("preserves the bounded cold projection without writes or writable loading", async () => {
  const f = await fixture()
  try {
    const before = await readFile(join(f.root, "sessions", "s.jsonl"))
    const profile = vi.spyOn(f.coordinator, "profile"), snapshot = vi.spyOn(f.coordinator, "snapshot")
    const load = vi.spyOn(f.coordinator, "load").mockImplementation(() => { throw new Error("writable load") })
    const value = await f.read("s", { limit: 1 }, () => {})
    expect(value).toMatchObject({ live: false, total: 2, offset: 0, hasMore: true, cells: [{ id: "new", source: "new source", canTerminate: false }] })
    expect(profile).toHaveBeenCalledTimes(1); expect(snapshot).toHaveBeenCalledTimes(1); expect(load).not.toHaveBeenCalled()
    expect(await f.read("s", { limit: 1 })).toEqual(value); expect(f.service.hasAssembly("s")).toBe(false)
    expect(await readFile(join(f.root, "sessions", "s.jsonl"))).toEqual(before)
  } finally { await f.close() }
})

it("rejects replacement during profile and accepts the new real owner", async () => {
  const f = await fixture(), held = latch(), entered = latch(), sentinel = new Error("owner replaced")
  try {
    const a = await f.service.assemblyFor("s")
    const original = f.coordinator.profile.bind(f.coordinator)
    const spy = vi.spyOn(f.coordinator, "profile").mockImplementationOnce(async id => { const value = await original(id); entered.release(); await held.promise; return value })
    const snapshot = vi.spyOn(f.coordinator, "snapshot")
    const old = f.read("s", {}, () => { if (f.service.liveAssembly("s") !== a) throw sentinel })
    await entered.promise; await f.service.closeSession("s"); const b = await f.service.assemblyFor("s"); expect(b).not.toBe(a); held.release()
    await expect(old).rejects.toBe(sentinel)
    const fresh = await f.read("s", {}, () => { if (f.service.liveAssembly("s") !== b) throw sentinel })
    expect(fresh).toMatchObject({ live: true, cells: [{ id: "new" }, { id: "old" }] }); expect(snapshot).not.toHaveBeenCalled(); expect(spy).toHaveBeenCalledTimes(2)
  } finally { held.release(); await f.close() }
})

it("rejects cold to live transition while snapshot is held", async () => {
  const f = await fixture(), held = latch(), entered = latch(), sentinel = new Error("owner appeared")
  try {
    const original = f.coordinator.snapshot!.bind(f.coordinator)
    vi.spyOn(f.coordinator as Required<typeof f.coordinator>, "snapshot").mockImplementationOnce(async (id: string) => { const value = await original(id); entered.release(); await held.promise; return value })
    const old = f.read("s", {}, () => { if (f.service.liveAssembly("s")) throw sentinel })
    await entered.promise; const owner = await f.service.assemblyFor("s"); held.release()
    await expect(old).rejects.toBe(sentinel)
    expect(await f.read("s", {}, () => { if (f.service.liveAssembly("s") !== owner) throw sentinel })).toMatchObject({ live: true })
  } finally { held.release(); await f.close() }
})

it("checks currentness after synchronous live DTO projection", async () => {
  const f = await fixture(), sentinel = new Error("projection revoked")
  try {
    const owner = await f.service.assemblyFor("s"), original = owner.executionState!.bind(owner)
    let current = true
    vi.spyOn(owner as typeof owner & { executionState: NonNullable<typeof owner.executionState> }, "executionState").mockImplementation(() => { const state = original(); current = false; return state })
    const snapshot = vi.spyOn(f.coordinator, "snapshot")
    await expect(f.read("s", {}, () => { if (!current) throw sentinel })).rejects.toBe(sentinel)
    expect(snapshot).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("propagates falsey assertion reasons and refuses missing snapshots without loading", async () => {
  const f = await fixture()
  try {
    let caught: unknown = Symbol("unset")
    try { await f.read("s", {}, () => { throw undefined }) } catch (error) { caught = error }
    expect(caught).toBeUndefined()
    const load = vi.spyOn(f.coordinator, "load")
    const backend = { ...f.coordinator, snapshot: undefined }
    await expect(readDesktopSnapshot(backend, "s")).rejects.toThrow(/snapshot inspection is unavailable/)
    expect(load).not.toHaveBeenCalled()
    await expect(f.read("", {})).rejects.toThrow(/resource id/)
    await expect(f.read("s", { limit: 21 })).rejects.toThrow(/cursor or dimension/)
    await expect(f.read("s", { offset: -1 })).rejects.toThrow(/cursor or dimension/)
    await expect(createDesktopExecution(f.coordinator, f.service).stop("s", "new")).rejects.toThrow(/cold|owner/)
  } finally { await f.close() }
})
