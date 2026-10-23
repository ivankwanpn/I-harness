import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFsWatcher, createFsWatchService, type WatchNotification } from "../src/index.ts"
import { dirname, join, parse, resolve } from "node:path"
import { gate, PushRoute, PushWatcher, turns, watchdog } from "./helpers/push-watcher.ts"

const seam = vi.hoisted(() => ({ watch: vi.fn(), read: vi.fn(), route: vi.fn(), stat: vi.fn() }))
vi.mock("chokidar", () => ({ watch: seam.watch }))
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), watch: seam.route }))
vi.mock("node:fs/promises", () => ({ readdir: seam.read, lstat: seam.stat }))
let native: PushWatcher
beforeEach(() => {
  native = new PushWatcher()
  seam.watch.mockReset().mockReturnValue(native)
  seam.read.mockReset().mockResolvedValue([])
  seam.stat.mockReset().mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => false })
  seam.route.mockReset().mockImplementation((_path, _options, callback) => {
    const route = new PushRoute(); route.on("change", callback); return route
  })
})
afterEach(() => vi.useRealTimers())

describe("maintained stream lifecycle", () => {
  it("joins concurrent closes and synchronously settles every waiting reader", async () => {
    const closeGate = gate()
    native.close.mockReturnValue(closeGate.promise)
    const w = createFsWatcher({ roots: ["."], persistent: false })
    native.ready(); await turns()
    const iterator = w.events[Symbol.asyncIterator]()
    const reads = [iterator.next(), iterator.next()]
    await turns()
    const first = w.close(), second = w.close()
    try {
      expect(second).toBe(first)
      expect(await watchdog(Promise.all(reads))).toEqual([{ done: true, value: undefined }, { done: true, value: undefined }])
      let completed = false
      void second.then(() => { completed = true })
      await turns(); expect(completed).toBe(false)
    } finally { closeGate.resolve(); await Promise.all([first, second]) }
  })

  it.each([false, true])("rejects all readers on backend failure (already ready: %s)", async ready => {
    const w = createFsWatcher({ roots: ["."] })
    if (ready) { native.ready(); await turns() }
    const iterator = w.events[Symbol.asyncIterator]()
    const reads = [iterator.next(), iterator.next()]
    const settled = Promise.allSettled(reads)
    await turns(); native.fail()
    try {
      const results = await watchdog(settled)
      expect(results.map(result => result.status)).toEqual(["rejected", "rejected"])
      for (const result of results) if (result.status === "rejected") expect(result.reason.code).toBe("FS_WATCH_BACKEND")
    } finally { await w.close() }
  })

  it("fails visibly when a held startup accumulates more than 4096 records", async () => {
    const baseline = gate<never[]>()
    seam.read.mockReturnValue(baseline.promise)
    const w = createFsWatcher({ roots: ["."] })
    const result = w.events[Symbol.asyncIterator]().next().catch(error => error)
    for (let i = 0; i < 4097; i++) native.change("change", `file-${i}`)
    native.ready()
    try { expect(await watchdog(result)).toMatchObject({ code: "FS_WATCH_GAP" }) }
    finally { baseline.resolve([]); await w.close() }
  })
})

it("readiness waits for baseline classification and close joins that job", async () => {
  const baseline = gate<never[]>()
  seam.read.mockReturnValue(baseline.promise)
  const w = createFsWatcher({ roots: ["."] })
  const ready = w.ready.catch(error => error)
  native.ready(); native.change("add", "early")
  let settled = false; void ready.then(() => { settled = true })
  await turns(); expect(settled).toBe(false)
  const iterator = w.events[Symbol.asyncIterator](), pending = iterator.next()
  const closing = w.close(); let closed = false; void closing.then(() => { closed = true })
  expect(await pending).toEqual({ done: true, value: undefined })
  expect(await ready).toMatchObject({ code: "FS_WATCH_CLOSED" })
  await turns(); expect(closed).toBe(false)
  baseline.resolve([]); await closing
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
})

it("a known conflicting startup sequence is a gap, never silently erased", async () => {
  const baseline = gate<never[]>()
  seam.read.mockReturnValue(baseline.promise)
  const w = createFsWatcher({ roots: ["."] })
  const ready = w.ready.catch(error => error)
  const iterator = w.events[Symbol.asyncIterator](), pending = iterator.next().catch(error => error)
  for (const kind of ["add", "unlink", "add"]) native.change(kind, "early")
  native.ready(); baseline.resolve([])
  expect(await ready).toMatchObject({ code: "FS_WATCH_GAP" })
  expect(await pending).toBe(await ready)
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
  const late = w.events[Symbol.asyncIterator]()
  await expect(late.next()).rejects.toMatchObject({ code: "FS_WATCH_GAP" })
  expect(await late.next()).toEqual({ done: true, value: undefined })
  await w.close()
})

it("uses one quiet timer, preserves ordered kinds and caps continuous bursts at 1000ms", async () => {
  vi.useFakeTimers()
  const w = createFsWatcher({ roots: ["."], persistent: false })
  native.ready(); await w.ready
  const iterator = w.events[Symbol.asyncIterator]()
  const read = iterator.next(); let delivered = false; void read.then(() => { delivered = true })
  native.change("add", "a"); native.change("add", "a")
  await vi.advanceTimersByTimeAsync(99); expect(delivered).toBe(false)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect((await read).value).toEqual({ kind: "add", path: "a" })
  const burst = iterator.next(); let burstDone = false; void burst.then(() => { burstDone = true })
  for (let i = 0; i < 11; i++) {
    native.change(i % 2 ? "unlink" : "change", "a")
    await vi.advanceTimersByTimeAsync(90)
  }
  expect(burstDone).toBe(false)
  await vi.advanceTimersByTimeAsync(10); expect(burstDone).toBe(true)
  expect((await burst).value).toEqual({ kind: "change", path: "a" })
  expect((await iterator.next()).value).toEqual({ kind: "unlink", path: "a" })
  await w.close(); expect(vi.getTimerCount()).toBe(0)
})

it("counts UTF8 bytes and pending read capacity, with every waiter rejecting", async () => {
  const w = createFsWatcher({ roots: ["."] })
  const result = w.events[Symbol.asyncIterator]().next().catch(error => error)
  native.change("add", "界".repeat(350_000))
  expect(await result).toMatchObject({ code: "FS_WATCH_GAP" })
  await w.close()
  const next = createFsWatcher({ roots: ["."] })
  const reads = Array.from({ length: 65 }, () => next.events[Symbol.asyncIterator]().next())
  const settled = await Promise.allSettled(reads)
  expect(settled.every(result => result.status === "rejected" && result.reason.code === "FS_WATCH_CAPACITY")).toBe(true)
  await next.close()
})

it("accepts exactly 4096 queued records, and retries only failed close resources", async () => {
  vi.useFakeTimers()
  const w = createFsWatcher({ roots: ["."] })
  native.ready(); await w.ready
  for (let i = 0; i < 4096; i++) native.change("change", `a-${i}`)
  await vi.advanceTimersByTimeAsync(100)
  const iterator = w.events[Symbol.asyncIterator]()
  expect((await iterator.next()).value).toEqual({ path: "a-0", kind: "change" })
  native.close.mockRejectedValueOnce(new Error("cleanup fault"))
  await expect(w.close()).rejects.toMatchObject({ code: "FS_WATCH_CLOSE" })
  const retry = w.close(); expect(w.close()).toBe(retry); await retry
  expect(native.close).toHaveBeenCalledTimes(2)
  expect(w.close()).toBe(retry)
})

it("is idle for ten fake minutes after readiness: no timer, reopen, baseline or stat polling", async () => {
  vi.useFakeTimers()
  const w = createFsWatcher({ roots: ["."], persistent: false })
  native.ready(); await w.ready
  expect(seam.watch.mock.calls[0]![1]).toMatchObject({ awaitWriteFinish: false, usePolling: false })
  const reads = seam.read.mock.calls.length
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(vi.getTimerCount()).toBe(0); expect(seam.watch).toHaveBeenCalledTimes(1)
  expect(seam.read).toHaveBeenCalledTimes(reads)
  await w.close()
})

it("accepts the exact 1MiB byte boundary and fails the next raw record", async () => {
  const baseline = gate<never[]>()
  seam.read.mockReturnValue(baseline.promise)
  const w = createFsWatcher({ roots: ["."] })
  const ready = w.ready.catch(error => error)
  native.change("change", "a".repeat(1_048_570))
  let settled = false; void ready.then(() => { settled = true })
  await turns(); expect(settled).toBe(false)
  native.change("add", "b")
  expect(await ready).toMatchObject({ code: "FS_WATCH_GAP" })
  baseline.resolve([]); await w.close()
})

it("bounds precomputed routing ancestry and deduplicates shared Windows-equivalent routes", async () => {
  const anchor = parse(resolve(".")).root
  const deep = join(anchor, ...Array.from({ length: 127 }, (_, i) => `r${i}`))
  const accepted = createFsWatcher({ roots: [deep, ...(process.platform === "win32" ? [deep.toUpperCase()] : [])] })
  await accepted.close()
  expect(() => createFsWatcher({ roots: [join(deep, "too-deep")] })).toThrowError(expect.objectContaining({ code: "FS_WATCH_CAPACITY" }))
  const wide = Array.from({ length: 256 }, (_, i) => join(anchor, `branch${i}`, ...Array.from({ length: i === 255 ? 14 : 15 }, (_, j) => `r${j}`)))
  const boundary = createFsWatcher({ roots: wide }); await boundary.close()
  wide[255] = join(wide[255]!, "one-more")
  expect(() => createFsWatcher({ roots: wide })).toThrowError(expect.objectContaining({ code: "FS_WATCH_CAPACITY" }))
})

it("permits only supplied descendant coverage and exact ignored routing paths", async () => {
  const root = resolve("routing-fixture"), file = join(root, ".i-harness", "rules", "AGENTS.md"), marker = join(root, ".git")
  const w = createFsWatcher({ roots: [file, marker], ignore: ["private"] })
  const [anchors, options] = seam.watch.mock.calls[0]!
  expect(anchors).toEqual([file, marker].sort())
  const routePaths = seam.route.mock.calls.map(([path]) => path)
  expect(routePaths).toContain(parse(root).root); expect(routePaths).toContain(dirname(file))
  expect(routePaths).not.toContain(file); expect(routePaths).not.toContain(marker)
  const ignored = options.ignored as (path: string) => boolean
  for (const path of [root, dirname(file), file, marker]) expect(ignored(path)).toBe(false)
  for (const path of [join(root, "sibling"), join(dirname(file), "CLAUDE.md"), join(marker, "config"), join(root, "private", "x")]) expect(ignored(path)).toBe(true)
  if (process.platform === "win32") expect(ignored(file.toUpperCase())).toBe(false)
  await w.close()
})

it("holds topology recovery behind old close, filters anchors, and fences late raw callbacks", async () => {
  vi.useFakeTimers()
  const root = resolve("routing-fixture"), parent = join(root, ".i-harness"), file = join(parent, "AGENTS.md")
  const first = native, hold = gate()
  first.close.mockReturnValue(hold.promise)
  const service = createFsWatchService(), lease = service.acquire({ roots: [file], persistent: false })
  const events: WatchNotification[] = []
  lease.subscribe(event => events.push(event))
  first.change("addDir", parent); first.ready(); await lease.ready
  const route = seam.route.mock.results[seam.route.mock.calls.findIndex(([path]) => path === root)]!.value as PushRoute
  expect(events).toEqual([{ kind: "reset", reason: "initial", cursor: { epoch: 1, revision: 1 } }])
  route.emit("change", "rename", "unrelated")
  route.emit("change", "change", ".i-harness")
  first.change("change", join(root, "unrelated")); await vi.advanceTimersByTimeAsync(100)
  expect(events).toHaveLength(1)
  route.emit("change", "rename", process.platform === "win32" ? ".I-HARNESS" : ".i-harness"); await turns()
  expect(events.at(-1)).toMatchObject({ kind: "unavailable", code: "FS_WATCH_GAP" })
  await vi.advanceTimersByTimeAsync(1000); expect(seam.watch).toHaveBeenCalledTimes(1)
  first.change("change", file); first.ready(); route.emit("change", "rename", ".i-harness")
  const second = new PushWatcher(); seam.watch.mockReturnValue(second)
  hold.resolve(); await turns(); await vi.advanceTimersByTimeAsync(500)
  expect(seam.watch).toHaveBeenCalledTimes(2)
  second.change("addDir", parent); second.ready(); await turns()
  expect(events.at(-1)).toMatchObject({ kind: "reset", reason: "recovered", cursor: { epoch: 2, revision: 1 } })
  const before = events.length
  first.change("change", file); first.fail(); route.emit("change", "rename", ".i-harness")
  await vi.advanceTimersByTimeAsync(100); expect(events).toHaveLength(before)
  second.change("change", file); await vi.advanceTimersByTimeAsync(101)
  expect(events.at(-1)).toMatchObject({ kind: "changed", changes: [{ kind: "change", path: file }], cursor: { epoch: 2 } })
  await service.close(); expect(vi.getTimerCount()).toBe(0)
})

it("joins every shallow handle close event and retries only failed route closes", async () => {
  const w = createFsWatcher({ roots: ["."], persistent: false })
  native.ready(); await w.ready
  const routes = seam.route.mock.results.map(result => result.value as PushRoute)
  const held = routes[0]!, failing = routes[1]!
  held.close.mockImplementationOnce(() => {})
  failing.close.mockImplementationOnce(() => { throw new Error("route close failed") })
  const closing = w.close(), failed = closing.catch(error => error)
  let settled = false; void failed.then(() => { settled = true })
  await turns(); expect(settled).toBe(false)
  held.emit("close")
  expect(await failed).toMatchObject({ code: "FS_WATCH_CLOSE" })
  await w.close()
  expect(held.close).toHaveBeenCalledTimes(1); expect(failing.close).toHaveBeenCalledTimes(2)
  expect(routes.slice(2).every(route => route.close.mock.calls.length === 1)).toBe(true)
  expect(native.close).toHaveBeenCalledTimes(1)
})

it("routes shallow handle errors through the existing source failure and joins pending original-root inspections", async () => {
  const root = resolve("future-directory"), parent = dirname(root), stat = gate<{ isDirectory: () => boolean; isSymbolicLink: () => boolean }>()
  seam.stat.mockReturnValue(stat.promise)
  const w = createFsWatcher({ roots: [root], persistent: false })
  native.ready(); await w.ready
  const route = seam.route.mock.results[seam.route.mock.calls.findIndex(([path]) => path === parent)]!.value as PushRoute
  route.emit("change", "rename", "unrelated")
  expect(seam.stat).not.toHaveBeenCalled()
  route.emit("change", "rename", "future-directory"); route.emit("change", "rename", "future-directory")
  expect(seam.stat).toHaveBeenCalledExactlyOnceWith(root)
  const read = w.events[Symbol.asyncIterator]().next().catch(error => error)
  route.emit("error", new Error("routing handle failed"))
  expect(await read).toMatchObject({ code: "FS_WATCH_BACKEND" })
  const closing = w.close(); let settled = false; void closing.then(() => { settled = true })
  await turns(); expect(settled).toBe(false)
  route.emit("change", "rename", "future-directory")
  stat.resolve({ isDirectory: () => true, isSymbolicLink: () => false }); await closing
  expect(seam.stat).toHaveBeenCalledTimes(1)
})

it("does not restart recovery until a shallow route close completes", async () => {
  vi.useFakeTimers()
  const service = createFsWatchService(), lease = service.acquire({ roots: ["."], persistent: false })
  const events: WatchNotification[] = []; lease.subscribe(event => events.push(event))
  native.ready(); await lease.ready
  const route = seam.route.mock.results[0]!.value as PushRoute
  route.close.mockImplementationOnce(() => {})
  route.emit("change", "rename", null); await turns()
  expect(events.at(-1)).toMatchObject({ kind: "unavailable", code: "FS_WATCH_GAP" })
  await vi.advanceTimersByTimeAsync(5000)
  expect(seam.watch).toHaveBeenCalledTimes(1)
  route.emit("close"); await turns(); await vi.advanceTimersByTimeAsync(500)
  expect(seam.watch).toHaveBeenCalledTimes(2)
  await service.close()
})
