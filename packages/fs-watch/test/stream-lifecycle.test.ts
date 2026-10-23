import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFsWatcher } from "../src/index.ts"
import { gate, PushWatcher, turns, watchdog } from "./helpers/push-watcher.ts"

const seam = vi.hoisted(() => ({ watch: vi.fn(), read: vi.fn() }))
vi.mock("chokidar", () => ({ watch: seam.watch }))
vi.mock("node:fs/promises", () => ({ readdir: seam.read }))
let native: PushWatcher
beforeEach(() => {
  native = new PushWatcher()
  seam.watch.mockReset().mockReturnValue(native)
  seam.read.mockReset().mockResolvedValue([])
})
afterEach(() => vi.useRealTimers())

describe("maintained stream lifecycle", () => {
  it("joins concurrent closes and synchronously settles every waiting reader", async () => {
    const closeGate = gate()
    native.close.mockReturnValue(closeGate.promise)
    const w = createFsWatcher({ roots: ["missing-root"], persistent: false })
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
    const w = createFsWatcher({ roots: ["missing-root"] })
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
    const w = createFsWatcher({ roots: ["missing-root"] })
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
  const w = createFsWatcher({ roots: ["missing-root"] })
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
  const w = createFsWatcher({ roots: ["missing-root"] })
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
  const w = createFsWatcher({ roots: ["missing-root"], persistent: false })
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
  const w = createFsWatcher({ roots: ["missing-root"] })
  const result = w.events[Symbol.asyncIterator]().next().catch(error => error)
  native.change("add", "界".repeat(350_000))
  expect(await result).toMatchObject({ code: "FS_WATCH_GAP" })
  await w.close()
  const next = createFsWatcher({ roots: ["missing-root"] })
  const reads = Array.from({ length: 65 }, () => next.events[Symbol.asyncIterator]().next())
  const settled = await Promise.allSettled(reads)
  expect(settled.every(result => result.status === "rejected" && result.reason.code === "FS_WATCH_CAPACITY")).toBe(true)
  await next.close()
})

it("accepts exactly 4096 queued records, and retries only failed close resources", async () => {
  vi.useFakeTimers()
  const w = createFsWatcher({ roots: ["missing-root"] })
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
  const w = createFsWatcher({ roots: ["missing-root"], persistent: false })
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
  const w = createFsWatcher({ roots: ["missing-root"] })
  const ready = w.ready.catch(error => error)
  native.change("change", "a".repeat(1_048_570))
  let settled = false; void ready.then(() => { settled = true })
  await turns(); expect(settled).toBe(false)
  native.change("add", "b")
  expect(await ready).toMatchObject({ code: "FS_WATCH_GAP" })
  baseline.resolve([]); await w.close()
})
