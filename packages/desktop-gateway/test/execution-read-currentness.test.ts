import { expect, it, vi } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const profileGate=vi.hoisted(()=>({path:'',blocked:false,entered:undefined as (()=>void)|undefined,release:undefined as Promise<void>|undefined}))
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,async readFile(...args:Parameters<typeof fs.readFile>){const value=await fs.readFile(...args);if(profileGate.blocked&&String(args[0])===profileGate.path){profileGate.entered?.();await profileGate.release}return value}}})
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '@i-harness/subagent/internal/task-storage-contract'
const createSessionCoordinator = (backend: Parameters<typeof composeJsonlTaskTransitionCoordinator>[0], options?: Parameters<typeof composeJsonlTaskTransitionCoordinator>[1]) => composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract)
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import { createDesktopExecution, readDesktopSnapshot } from "../src/execution.ts"
import { recordFixture } from "./managed-fixture.ts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-currentness-"))
  const backend = createJsonlBackend(join(root, "sessions"))
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: "s" })
  const doc = await coordinator.openManagedDocument("s")
  await recordFixture(doc, { type: "code/cell", cellId: "old", sessionId: "s", state: "started", source: "old source" })
  await recordFixture(doc, { type: "code/cell", cellId: "new", sessionId: "s", state: "completed", source: "new source" })
  await coordinator.flush("s")
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", codeMode: { mode: "mixed" }, coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  return { root, backend, doc, coordinator, service, read: createDesktopExecution(coordinator, service).read, async close() { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
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

it("reads a reopened cold journal without entering writable, recovery, or model paths", async () => {
  const f = await fixture()
  await f.service.close(); await f.coordinator.close()
  const backend = createJsonlBackend(join(f.root, "sessions"))
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const repair = vi.spyOn(backend, "repair").mockImplementation(async () => { throw new Error("repair") })
  const upgrade = vi.spyOn(backend as Required<typeof backend>, "upgradeSessionFormat").mockImplementation(async () => { throw new Error("upgrade") })
  const append = vi.spyOn(backend, "append").mockImplementation(async () => { throw new Error("append") })
  const replace = vi.spyOn(backend as Required<typeof backend>, "replaceEvents").mockImplementation(async () => { throw new Error("replace") })
  const load = vi.spyOn(coordinator, "load").mockImplementation(async () => { throw new Error("load") })
  const loadOwned = vi.spyOn(coordinator, "loadOwned").mockImplementation(async () => { throw new Error("loadOwned") })
  const sessionFor = vi.fn(async () => { throw new Error("sessionFor") })
  const stream = vi.fn(async function* () { throw new Error("model"); yield { type: "end" as const } })
  const service = createSessionService({ workspace: f.root, coordinator, sessionFor, model: { stream } })
  const assemblyFor = vi.spyOn(service, "assemblyFor")
  const bytes = await readFile(join(f.root, "sessions", "s.jsonl"))
  try {
    const view = await createDesktopExecution(coordinator, service).read("s")
    expect(view.cells.map(cell => cell.id)).toEqual(["new", "old"])
    expect(service.hasAssembly("s")).toBe(false)
    for (const trap of [repair, upgrade, append, replace, load, loadOwned, sessionFor, stream, assemblyFor]) expect(trap).not.toHaveBeenCalled()
    expect(await readFile(join(f.root, "sessions", "s.jsonl"))).toEqual(bytes)
  } finally { await service.close(); await coordinator.close(); await rm(f.root, { recursive: true, force: true }) }
})

it("keeps omitted-callback pagination and per-cell content bounds", async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 11; i++) await recordFixture(f.doc, { type: "code/cell", cellId: `page-${i}`, sessionId: "s", state: "completed", source: `source-${i}` })
    await recordFixture(f.doc, { type: "code/cell", cellId: "bounded", sessionId: "s", state: "completed", source: "s".repeat(65530) })
    for (let i = 0; i < 101; i++) {
      await recordFixture(f.doc, { type: "code/output", cellId: "bounded", content: { type: "text", text: "output" } })
      await recordFixture(f.doc, { type: "code/call", cellId: "bounded", callId: `call-${i}`, name: "fixture", args: "arguments" })
    }
    await f.coordinator.flush("s")
    const page = await f.read("s")
    expect(page).toMatchObject({ total: 14, offset: 0, hasMore: true })
    expect(page.cells.map(cell => cell.id)).toEqual(["bounded", ...Array.from({ length: 9 }, (_, i) => `page-${10-i}`)])
    const cell = page.cells[0]!
    expect(cell.output).toHaveLength(100); expect(cell.calls).toHaveLength(100); expect(cell.truncated).toBe(true)
    expect(cell.source.length + cell.output.reduce((n, item) => n + item.text.length, 0) + cell.calls.reduce((n, item) => n + item.args.length, 0)).toBe(65536)
    const tail = await f.read("s", { offset: 10, limit: 20 })
    expect(tail.cells.map(cell => cell.id)).toEqual(["page-1", "page-0", "new", "old"])
    expect(tail.hasMore).toBe(false)
  } finally { await f.close() }
})

it("flushes only after the real live owner has stopped the cell", async () => {
  const f = await fixture()
  try {
    const owner = await f.service.assemblyFor("s")
    const started = await owner.tools.execute({ name: "code_exec", args: { code: "await new Promise(resolve => setTimeout(resolve, 20000))", yield_time_ms: 0 } })
    const cellId = (started.output as { cell_id: string }).cell_id
    const order: string[] = []
    const originalStop = owner.stopCodeCell!.bind(owner), originalFlush = f.coordinator.flush.bind(f.coordinator)
    vi.spyOn(owner as typeof owner & { stopCodeCell: NonNullable<typeof owner.stopCodeCell> }, "stopCodeCell").mockImplementation(async id => { order.push("stop-start"); await originalStop(id); order.push("stop-end") })
    vi.spyOn(f.coordinator, "flush").mockImplementation(async id => { order.push("flush"); return originalFlush(id) })
    expect(await createDesktopExecution(f.coordinator, f.service).stop("s", cellId)).toEqual({ stopped: true, cellId })
    expect(order).toEqual(["stop-start", "stop-end", "flush"])
  } finally { await f.close() }
}, 15000)

it('uses the retained profile port inside the real cold execution read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-retained-profile-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true, lockRoot: root } })
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    const service = { liveAssembly: () => undefined }
    const read = createDesktopExecution(coordinator, service).read
    const ordinary = vi.spyOn(coordinator, 'profile')
    const view = await ref.withRead(profile => read('s', {}, () => ref.assertCurrent(), profile))
    expect(view.total).toBe(0)
    expect(ordinary).not.toHaveBeenCalled()
    await ref.release()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('denies a held real retained profile after release and permits a fresh reference and manual read', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'ih-held-retained-profile-'))
  const backend = createJsonlBackend(root), entered = latch(), held = latch()
  profileGate.path=join(root,'s.jsonl');profileGate.entered=entered.release;profileGate.release=held.promise
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true, lockRoot: root } })
  const service = { liveAssembly: vi.fn(() => undefined) }, snapshot = vi.spyOn(coordinator, 'snapshot'), ordinary = vi.spyOn(coordinator, 'profile')
  try {
    await coordinator.create({ sessionId: 's' }); await coordinator.releaseOwnership('s')
    const ref = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    const read = createDesktopExecution(coordinator, service).read
    profileGate.blocked = true
    const pending = ref.withRead(profile => read('s', {}, () => ref.assertCurrent(), profile)); void pending.catch(() => {})
    await entered.promise
    const releasing = ref.release(); void releasing.catch(() => {})
    expect(() => ref.assertCurrent()).toThrow()
    held.release(); await expect(pending).rejects.toThrow(); await releasing
    expect(service.liveAssembly).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled(); expect(ordinary).not.toHaveBeenCalled()
    profileGate.blocked = false
    const fresh = await coordinator.retainExistingSessionBindingObservation!({ sessionId: 's' }, () => {})
    expect((await fresh.withRead(profile => read('s', {}, () => fresh.assertCurrent(), profile))).total).toBe(0)
    await fresh.release()
    ordinary.mockClear(); expect((await read('s')).total).toBe(0); expect(ordinary).toHaveBeenCalledOnce()
  } finally { profileGate.blocked=false;held.release(); await coordinator.close(); await rm(root, { recursive: true, force: true });profileGate.path='';profileGate.entered=undefined;profileGate.release=undefined }
})
