import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFsWatchService, type WatchCursor, type WatchLease, type WatchNotification } from "../src/index.ts"
import { gate, PushWatcher, turns } from "./helpers/push-watcher.ts"
import { resolve } from "node:path"

const seam = vi.hoisted(() => ({ watch: vi.fn() }))
vi.mock("chokidar", () => ({ watch: seam.watch }))
vi.mock("node:fs/promises", () => ({ readdir: async () => [] }))
let natives: PushWatcher[]
beforeEach(() => {
  vi.useFakeTimers()
  natives = []
  seam.watch.mockReset().mockImplementation(() => {
    const native = new PushWatcher(); natives.push(native); return native
  })
})
afterEach(() => vi.useRealTimers())
const selection = { roots: ["missing-watch-root"], persistent: false }
async function start() { for (const native of natives) native.ready(); await turns() }
async function flush() { await vi.advanceTimersByTimeAsync(101); await turns() }

describe("explicit watch service leases", () => {
  it("shares equivalent selections only within the owning service and copies options", async () => {
    const service = createFsWatchService(), other = createFsWatchService()
    const options = { roots: ["missing-watch-root", "./missing-watch-root"], ignore: ["z", "a", "z"], persistent: false }
    const a = service.acquire(options)
    options.roots[0] = "mutated"; options.ignore[0] = "mutated"
    const b = service.acquire({ roots: [resolve("missing-watch-root")], ignore: ["a", "z"], persistent: false })
    const c = other.acquire(selection)
    const d = service.acquire({ ...selection, persistent: true })
    try {
      expect(natives).toHaveLength(3)
      await start(); await Promise.all([a.ready, b.ready, c.ready, d.ready])
      await a.close(); expect(natives[0]!.close).not.toHaveBeenCalled()
      await b.close(); expect(natives[0]!.close).toHaveBeenCalledTimes(1)
    } finally { await service.close(); await other.close() }
  })

  it("initializes subscribers before full ordered deltas and isolates immutable notifications", async () => {
    const service = createFsWatchService()
    const a = service.acquire(selection), b = service.acquire(selection)
    const left: WatchNotification[] = [], right: WatchNotification[] = []
    a.subscribe(event => { left.push(event); try { (event.cursor as { revision: number }).revision = 1000 } catch {} })
    b.subscribe(event => right.push(event))
    await start(); expect(await a.ready).toEqual({ epoch: 1, revision: 1 })
    for (const kind of ["add", "change", "unlink"]) natives[0]!.change(kind, "a")
    await flush()
    expect(right[0]).toMatchObject({ kind: "reset", reason: "initial" })
    expect(right.at(-1)).toMatchObject({ kind: "changed", changes: [{ path: "a", kind: "add" }, { path: "a", kind: "change" }, { path: "a", kind: "unlink" }] })
    expect(left).toEqual(right)
    const late: WatchNotification[] = []
    b.subscribe(event => late.push(event)); natives[0]!.change("change", "b")
    await flush()
    expect(late[0]).toMatchObject({ kind: "reset", reason: "subscribe" })
    await service.close()
  })

  it("rejects invalid selections and exact key/lease/listener capacities before native work", async () => {
    const service = createFsWatchService()
    for (const roots of [[], [""], Array.from({ length: 257 }, (_, i) => `root-${i}`)]) {
      expect(() => service.acquire({ roots })).toThrowError(expect.objectContaining({ code: "FS_WATCH_CAPACITY" }))
    }
    expect(natives).toHaveLength(0)
    expect(() => service.acquire({ roots: ["valid"], ignore: Array.from({ length: 257 }, (_, i) => `ignore-${i}`) }))
      .toThrowError(expect.objectContaining({ code: "FS_WATCH_CAPACITY" }))
    const leases = Array.from({ length: 64 }, () => service.acquire(selection))
    expect(() => service.acquire(selection)).toThrowError(expect.objectContaining({ code: "FS_WATCH_CAPACITY" }))
    const remove = Array.from({ length: 16 }, () => leases[0]!.subscribe(() => {}))
    expect(() => leases[0]!.subscribe(() => {})).toThrowError(expect.objectContaining({ code: "FS_WATCH_CAPACITY" }))
    remove[0]!(); leases[0]!.subscribe(() => {})
    for (let i = 1; i < 128; i++) service.acquire({ roots: [`root-${i}`] })
    expect(() => service.acquire({ roots: ["one-too-many"] })).toThrowError(expect.objectContaining({ code: "FS_WATCH_CAPACITY" }))
    await service.close()
  })

  it("replaces an overflowing batch by one reset without reopening a healthy backend", async () => {
    const service = createFsWatchService(), lease = service.acquire(selection)
    const events: WatchNotification[] = []; lease.subscribe(event => events.push(event))
    await start(); await lease.ready
    for (let i = 0; i < 257; i++) natives[0]!.change("change", `file-${i}`)
    await flush()
    expect(events.filter(event => event.kind === "reset" && event.reason === "overflow")).toHaveLength(1)
    expect(events.filter(event => event.kind === "changed")).toHaveLength(0)
    expect(natives).toHaveLength(1)
    natives[0]!.change("unlink", "later"); await flush()
    expect(events.at(-1)).toMatchObject({ kind: "changed", changes: [{ path: "later", kind: "unlink" }] })
    await service.close()
  })

  it("joins failed cleanup before replacement, fences old generation and recovers with reset", async () => {
    const service = createFsWatchService(), lease = service.acquire(selection)
    const events: WatchNotification[] = []; lease.subscribe(event => events.push(event))
    await start(); await lease.ready
    natives[0]!.close.mockRejectedValueOnce(new Error("held handle"))
    natives[0]!.fail(); await turns()
    expect(events.at(-1)).toMatchObject({ kind: "unavailable", code: "FS_WATCH_CLOSE" })
    expect(natives).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(499); expect(natives).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1); expect(natives).toHaveLength(2)
    natives[0]!.change("change", "stale"); natives[0]!.ready()
    natives[1]!.ready(); await turns()
    expect(events.at(-1)).toMatchObject({ kind: "reset", reason: "recovered", cursor: { epoch: 2, revision: 1 } })
    expect(JSON.stringify(events)).not.toContain("stale")
    await service.close()
  })

  it("keeps last-close tombstones until cleanup completes when a new lease arrives", async () => {
    const service = createFsWatchService(), a = service.acquire(selection)
    await start(); await a.ready
    const hold = gate(); natives[0]!.close.mockReturnValue(hold.promise)
    const closing = a.close(); expect(a.close()).toBe(closing)
    const b = service.acquire(selection)
    const events: WatchNotification[] = []; b.subscribe(event => events.push(event))
    await turns(); expect(natives).toHaveLength(1)
    hold.resolve(); await closing; await turns()
    expect(natives).toHaveLength(2)
    natives[1]!.ready(); await b.ready; await turns()
    expect(events[0]).toMatchObject({ kind: "reset" })
    const done = service.close(); expect(service.close()).toBe(done); await done
    expect(() => service.acquire(selection)).toThrowError(expect.objectContaining({ code: "FS_WATCH_CLOSED" }))
    expect(() => b.subscribe(() => {})).toThrowError(expect.objectContaining({ code: "FS_WATCH_CLOSED" }))
  })
})


it("isolates observer exceptions and fences reentrant unsubscribe/close", async () => {
  const errors: unknown[] = []
  const service = createFsWatchService({ onObserverError(error) { errors.push(error); throw new Error("reporter") } })
  const a = service.acquire(selection), b = service.acquire(selection)
  const right: WatchNotification[] = []
  let remove = () => {}
  a.subscribe(event => { if (event.kind === "changed") { remove(); void b.close(); throw new Error("observer") } })
  remove = a.subscribe(event => { if (event.kind === "changed") throw new Error("retired listener ran") })
  b.subscribe(event => right.push(event))
  await start(); natives[0]!.change("change", "a"); await flush()
  expect(errors).toHaveLength(1); expect((errors[0] as Error).message).toBe("observer")
  expect(right.every(event => event.kind === "reset")).toBe(true)
  await service.close()
})

it("settles pre-ready failure once but still delivers recovered reset to its subscribers", async () => {
  const service = createFsWatchService(), lease = service.acquire(selection)
  const events: WatchNotification[] = []; lease.subscribe(event => events.push(event))
  const ready = lease.ready.catch(error => error)
  natives[0]!.fail(); await turns()
  expect(await ready).toMatchObject({ code: "FS_WATCH_BACKEND" })
  expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ kind: "unavailable", code: "FS_WATCH_BACKEND" })
  await vi.advanceTimersByTimeAsync(500); natives[1]!.ready(); await turns()
  expect(events.at(-1)).toMatchObject({ kind: "reset", reason: "recovered" })
  expect(await ready).toMatchObject({ code: "FS_WATCH_BACKEND" })
  await service.close()
})

it("retries service cleanup failures with shared close promises and no surviving retries", async () => {
  const service = createFsWatchService(), lease = service.acquire(selection)
  await start(); await lease.ready
  natives[0]!.close.mockRejectedValueOnce(new Error("cleanup"))
  const close = service.close(); expect(service.close()).toBe(close)
  await expect(close).rejects.toBeInstanceOf(AggregateError)
  expect(() => lease.subscribe(() => {})).toThrowError(expect.objectContaining({ code: "FS_WATCH_CLOSED" }))
  const retry = service.close(); expect(service.close()).toBe(retry); await retry
  expect(natives[0]!.close).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(natives).toHaveLength(1); expect(vi.getTimerCount()).toBe(0)
})

it("repeated startup failures use bounded backoff and stop at zero leases", async () => {
  const service = createFsWatchService(), lease = service.acquire(selection)
  void lease.ready.catch(() => {})
  for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = natives.length
    natives.at(-1)!.fail(); await turns()
    await vi.advanceTimersByTimeAsync(delay - 1); expect(natives).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(1); expect(natives).toHaveLength(before + 1)
  }
  natives.at(-1)!.fail(); await turns(); await lease.close()
  await vi.advanceTimersByTimeAsync(600_000)
  expect(natives).toHaveLength(9); expect(vi.getTimerCount()).toBe(0)
  await service.close()
})

it("enforces service UTF8 batch bytes and allows the exact 256 record boundary", async () => {
  const service = createFsWatchService(), lease = service.acquire(selection)
  const events: WatchNotification[] = []; lease.subscribe(event => events.push(event))
  await start()
  for (let i = 0; i < 256; i++) natives[0]!.change("change", `a-${i}`)
  await flush()
  const changed = events.at(-1)!
  expect(changed.kind).toBe("changed")
  if (changed.kind === "changed") expect(changed.changes).toHaveLength(256)
  natives[0]!.change("change", "界".repeat(22_000)); await flush()
  expect(events.at(-1)).toMatchObject({ kind: "reset", reason: "overflow" })
  natives[0]!.change("change", "a".repeat(65_530)); await flush()
  expect(events.at(-1)?.kind).toBe("changed")
  natives[0]!.change("change", "a".repeat(65_531)); await flush()
  expect(events.at(-1)).toMatchObject({ kind: "reset", reason: "overflow" })
  expect(natives).toHaveLength(1)
  await service.close()
})

it("a listener added during fanout receives its own initialization before subsequent changes", async () => {
  const service = createFsWatchService(), lease = service.acquire(selection)
  const late: WatchNotification[] = []
  let subscribed = false
  lease.subscribe(event => { if (event.kind === "changed" && !subscribed) { subscribed = true; lease.subscribe(event => late.push(event)) } })
  await start(); natives[0]!.change("change", "a"); await flush()
  expect(late).toHaveLength(1); expect(late[0]).toMatchObject({ kind: "reset", reason: "subscribe" })
  natives[0]!.change("unlink", "a"); await flush()
  expect(late[1]).toMatchObject({ kind: "changed", changes: [{ path: "a", kind: "unlink" }] })
  await service.close()
})

it("a lease acquired after a failed last-close sees unavailable and retries the retained owner", async () => {
  const service = createFsWatchService(), a = service.acquire(selection)
  await start(); await a.ready
  natives[0]!.close.mockRejectedValueOnce(new Error("retained handle"))
  await expect(a.close()).rejects.toMatchObject({ code: "FS_WATCH_CLOSE" })
  const b = service.acquire(selection), events: WatchNotification[] = []
  const ready = b.ready.catch(error => error)
  b.subscribe(event => events.push(event))
  await turns()
  expect(events[0]).toMatchObject({ kind: "unavailable", code: "FS_WATCH_CLOSE" })
  expect(await ready).toMatchObject({ code: "FS_WATCH_CLOSE" })
  await vi.advanceTimersByTimeAsync(500)
  expect(natives).toHaveLength(2); expect(natives[0]!.close).toHaveBeenCalledTimes(2)
  natives[1]!.ready(); await turns()
  expect(events.at(-1)).toMatchObject({ kind: "reset", reason: "recovered" })
  await service.close()
})

it("a source gap clears unreliable deltas and recovers through a new epoch reset", async () => {
  const service = createFsWatchService(), lease = service.acquire(selection)
  const events: WatchNotification[] = []; lease.subscribe(event => events.push(event))
  await start(); await lease.ready
  for (let i = 0; i < 4097; i++) natives[0]!.change("change", `gap-${i}`)
  await turns()
  expect(events.at(-1)).toMatchObject({ kind: "unavailable", code: "FS_WATCH_GAP" })
  expect(events.some(event => event.kind === "changed")).toBe(false)
  await vi.advanceTimersByTimeAsync(500); natives[1]!.ready(); await turns()
  expect(events.at(-1)).toMatchObject({ kind: "reset", reason: "recovered", cursor: { epoch: 2, revision: 1 } })
  await service.close()
})

it("a healthy shared entry has no scheduled activity across ten fake minutes", async () => {
  const service = createFsWatchService(), a = service.acquire(selection), b = service.acquire(selection)
  const events: WatchNotification[] = []
  a.subscribe(event => events.push(event)); b.subscribe(() => {})
  await start(); await Promise.all([a.ready, b.ready])
  const before = events.length
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(events).toHaveLength(before); expect(natives).toHaveLength(1)
  expect(natives[0]!.close).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  await service.close()
})

it("retrying a retired lease close cannot close the recovered owner used by new leases", async () => {
  const service = createFsWatchService(), a = service.acquire(selection)
  await start(); await a.ready
  natives[0]!.close.mockRejectedValueOnce(new Error("retained handle"))
  await expect(a.close()).rejects.toMatchObject({ code: "FS_WATCH_CLOSE" })
  const b = service.acquire(selection); void b.ready.catch(() => {})
  const events: WatchNotification[] = []; b.subscribe(event => events.push(event))
  await vi.advanceTimersByTimeAsync(500); natives[1]!.ready(); await turns()
  await a.close()
  expect(natives[1]!.close).not.toHaveBeenCalled()
  natives[1]!.change("change", "still-live"); await flush()
  expect(events.at(-1)).toMatchObject({ kind: "changed", changes: [{ path: "still-live", kind: "change" }] })
  await service.close()
})

it.each([
  { reason: "initial", cleanupFails: false, epoch: 2 },
  { reason: "recovered", cleanupFails: false, epoch: 3 },
  { reason: "initial", cleanupFails: true, epoch: 2 },
  { reason: "recovered", cleanupFails: true, epoch: 3 },
])("reentrant $reason reset retirement fences replacement readiness (cleanupFails: $cleanupFails)", async ({ reason, cleanupFails, epoch }) => {
  const service = createFsWatchService(), a = service.acquire(selection)
  void a.ready.catch(() => {})
  if (reason === "recovered") {
    await start(); await a.ready
    natives[0]!.fail(); await turns(); await vi.advanceTimersByTimeAsync(500)
  }
  const retiring = natives.at(-1)!, oldCount = natives.length, hold = gate()
  retiring.close.mockReturnValueOnce(hold.promise)
  let b: WatchLease | undefined, closing: Promise<void> | undefined, sameClose = false
  let settlement: { cursor: WatchCursor } | { error: unknown } | undefined
  let eventsAtReady: WatchNotification[] | undefined
  const events: WatchNotification[] = []
  a.subscribe(event => {
    if (event.kind !== "reset" || event.reason !== reason) return
    closing = a.close(); sameClose = a.close() === closing
    void closing.catch(() => {})
    b = service.acquire(selection)
    b.subscribe(event => events.push(event))
    void b.ready.then(cursor => { settlement = { cursor }; eventsAtReady = [...events] }, error => { settlement = { error } })
  })
  try {
    retiring.ready(); await turns()
    expect(b).toBeDefined(); expect(sameClose).toBe(true)
    expect(settlement).toBeUndefined()
    expect(natives).toHaveLength(oldCount); expect(events).toEqual([])
    retiring.ready(); retiring.change("change", "stale")
    await flush()
    expect(settlement).toBeUndefined(); expect(events).toEqual([])
    if (cleanupFails) {
      hold.reject(new Error("held cleanup failure"))
      await expect(closing).rejects.toMatchObject({ code: "FS_WATCH_CLOSE" }); await turns()
      expect(settlement).toMatchObject({ error: { code: "FS_WATCH_CLOSE" } })
      expect(events).toMatchObject([{ kind: "unavailable", code: "FS_WATCH_CLOSE" }])
      expect(natives).toHaveLength(oldCount)
      await vi.advanceTimersByTimeAsync(500)
    } else {
      hold.resolve(); await closing; await turns()
      expect(settlement).toBeUndefined(); expect(events).toEqual([])
    }
    expect(natives).toHaveLength(oldCount + 1)
    const replacement = natives.at(-1)!
    // Construction alone must not settle readiness: the replacement owns its barrier.
    await turns()
    if (!cleanupFails) expect(settlement).toBeUndefined()
    replacement.ready(); await turns()
    if (cleanupFails) {
      expect(settlement).toMatchObject({ error: { code: "FS_WATCH_CLOSE" } })
      expect(events.at(-1)).toMatchObject({ kind: "reset", reason: "recovered", cursor: { epoch, revision: 1 } })
    } else {
      expect(await b!.ready).toEqual({ epoch, revision: 1 })
      expect(eventsAtReady).toEqual([{ kind: "reset", reason: "recovered", cursor: { epoch, revision: 1 } }])
    }
    replacement.change("change", "current"); await flush()
    expect(events.at(-1)).toMatchObject({ kind: "changed", cursor: { epoch }, changes: [{ path: "current", kind: "change" }] })
    expect(JSON.stringify(events)).not.toContain("stale")
  } finally { hold.resolve(); await service.close() }
})
