import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { createManagedPluginRegistry } from "../src/managed.ts"
import * as promises from "node:fs/promises"
import * as syncFs from "node:fs"
vi.mock("node:fs/promises", { spy: true })
vi.mock("node:fs", { spy: true })

it("joins a lease returned after synchronous acquisition shutdown", async () => {
  const close = vi.fn(async () => {})
  let closing!: Promise<void>
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch() {
    closing = managed.close()
    return { ready: Promise.resolve(), subscribe: () => () => {}, close }
  } })
  managed.observe(async () => {}, () => {})
  await closing
  expect(close).toHaveBeenCalledTimes(1)
})

it("joins independent observers and admitted lock work despite throwing detach and close", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-cleanup-joins-"))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const detached = new Error("detach"); const closeError = new Error("close")
  let n = 0, detaches = 0
  const closes = [vi.fn<() => Promise<void>>(() => { throw closeError }), vi.fn(async () => {})]
  const managed = createManagedPluginRegistry({ root }, { acquireStateWatch() {
    const index = n++
    return { ready: Promise.resolve(), subscribe: () => () => { if (index === 0 && ++detaches === 1) throw detached }, close: closes[index]! }
  } })
  managed.observe(async () => { await held }, () => {})
  managed.observe(async () => {}, () => {})
  let entered = false, jobDone = false
  const job = managed.run(async () => { entered = true; await held; jobDone = true })
  await vi.waitFor(() => expect(entered).toBe(true))
  let finished = false
  const closing = managed.close().then(() => undefined, error => error).finally(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(finished).toBe(false)
  expect(closes[1]).toHaveBeenCalledTimes(1)
  release(); await job
  expect(await closing).toBeInstanceOf(AggregateError)
  expect(jobDone).toBe(true)
  closes[0]!.mockImplementation(async () => {})
  await managed.close()
  await rm(root, { recursive: true, force: true })
})

it("joins async error reporting and preserves falsey primary and diagnostic rejection", async () => {
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const diagnostic = new Error("async report")
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe: () => () => {}, close: async () => {} }) })
  const observer = managed.observe(async () => { throw false }, async error => { expect(error).toBe(false); entered(); await held; throw diagnostic })
  await started
  let done = false
  const closing = observer.close().then(() => undefined, error => error).finally(() => { done = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(done).toBe(false)
  release()
  const failure = await closing as AggregateError
  expect((failure.errors[0] as AggregateError).errors).toEqual([false, diagnostic])
  await managed.close()
})

it.each(["change", "error"])("permits close from a %s callback descendant after the callback settles", async phase => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let descendant!: Promise<void>
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe: () => () => {}, close: async () => {} }) })
  const later = () => { descendant = held.then(() => managed.close()) }
  managed.observe(async () => { if (phase === "error") throw false; later() }, later)
  await vi.waitFor(() => expect(descendant).toBeDefined())
  release()
  await descendant
})

it("handles rejected ready when subscribe throws and retains acquired cleanup debt", async () => {
  const close = vi.fn(async () => {})
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.reject(undefined), subscribe() { throw new Error("subscribe") }, close }) })
  expect(() => managed.observe(async () => {}, () => {})).toThrow("subscribe")
  await managed.close()
  expect(close).toHaveBeenCalledTimes(1)
})

it("joins concurrent close calls while native cleanup is held and ignores late ready", async () => {
  let release!: () => void, ready!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const close = vi.fn(async () => { await held })
  let notify!: (event: { kind: "reset" }) => void
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: new Promise<void>(resolve => { ready = resolve }), subscribe(fn) { notify = fn; return () => {} }, close }) })
  const refresh = vi.fn(async () => {})
  const observer = managed.observe(refresh, () => {})
  const a = observer.close(), b = observer.close()
  expect(a).toBe(b)
  ready(); notify({ kind: "reset" })
  await new Promise(resolve => setImmediate(resolve))
  expect(close).toHaveBeenCalledTimes(1); expect(refresh).not.toHaveBeenCalled()
  release(); await Promise.all([a, b]); await managed.close()
})

it("drops pending dirty work on disposal while joining the admitted callback", async () => {
  let release!: () => void, notify!: (event: { kind: "changed" }) => void
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe(fn) { notify = fn; return () => {} }, close: async () => {} }) })
  const observer = managed.observe(async () => { calls++; await held }, () => {})
  await vi.waitFor(() => expect(calls).toBe(1))
  notify({ kind: "changed" }); observer.dispose(); notify({ kind: "changed" })
  let done = false
  const closing = observer.close().then(() => { done = true })
  await new Promise(resolve => setImmediate(resolve)); expect(done).toBe(false)
  release(); await closing; await managed.close(); expect(calls).toBe(1)
})

it("subscribes before reads, coalesces startup, serializes dirty catch-up and fences late hints", async () => {
  let notify!: (event: { kind: "changed" | "reset" }) => void, ready!: () => void
  let release!: () => void, releaseSecond!: () => void
  const first = new Promise<void>(resolve => { release = resolve })
  const second = new Promise<void>(resolve => { releaseSecond = resolve })
  const order: string[] = []; let calls = 0, active = 0, maximum = 0, state = 0, observed = -1
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: new Promise<void>(resolve => { ready = resolve }), subscribe(fn) { order.push("subscribe"); notify = fn; return () => {} }, close: async () => {} }) })
  const observer = managed.observe(async () => {
    order.push("read"); maximum = Math.max(maximum, ++active); const pass = ++calls
    if (pass === 1) await first
    if (pass === 2) await second
    observed = state; active--
  }, () => {})
  notify({ kind: "reset" }); ready(); notify({ kind: "reset" })
  await vi.waitFor(() => expect(calls).toBe(1))
  state = 1; notify({ kind: "changed" }); notify({ kind: "reset" }); release()
  await vi.waitFor(() => expect(calls).toBe(2))
  state = 2; notify({ kind: "changed" }); releaseSecond()
  await vi.waitFor(() => expect(calls).toBe(3))
  expect(observed).toBe(2); expect(maximum).toBe(1); expect(order[0]).toBe("subscribe")
  observer.dispose(); notify({ kind: "changed" }); ready()
  await observer.close(); await managed.close(); expect(calls).toBe(3)
})

it("refuses observer and managed close in active error handler before effects", async () => {
  let observer!: ReturnType<ReturnType<typeof createManagedPluginRegistry>["observe"]>
  let checked = false
  const close = vi.fn(async () => {})
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe: () => () => {}, close }) })
  observer = managed.observe(async () => { throw 0 }, async () => {
    await expect(observer.close()).rejects.toThrow("observer callback")
    await expect(managed.close()).rejects.toThrow("observer callback")
    expect(close).not.toHaveBeenCalled(); observer.dispose(); checked = true
  })
  await vi.waitFor(() => expect(checked).toBe(true))
  await managed.close()
})
it("reports missing cache without fetching while reading the Desktop catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-offline-"))
  const managed = createManagedPluginRegistry({ root })
  const fetch = vi.fn(() => { throw new Error("unexpected network") })
  vi.stubGlobal("fetch", fetch)
  try {
    await writeFile(join(root, "state.json"), JSON.stringify({ version: 1, sources: [{ name: "remote", source: "https://example.invalid/marketplace.json", lastUpdated: 1 }], plugins: [] }))
    const sources = await managed.run((registry) => registry.listSources({ fetchMissing: false }))
    expect(sources[0]?.error).toContain("refresh this source explicitly")
    expect(await managed.run((registry) => registry.catalog({ fetchMissing: false }))).toEqual({ plugins: [] })
    expect(fetch).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals(); await managed.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
it("refuses corrupt state and does not accept work after shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-managed-invalid-"))
  const managed = createManagedPluginRegistry({ root })
  try {
    await writeFile(join(root, "state.json"), "{broken")
    await expect(managed.run((registry) => registry.addSource("unused"))).rejects.toThrow("valid plugin registry state")
    expect(await readFile(join(root, "state.json"), "utf8")).toBe("{broken")
    await managed.close()
    await expect(managed.run((registry) => registry.catalog())).rejects.toThrow("closed")
  } finally { await managed.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
it("shares source/install/enable state between managed registry instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-managed-plugins-"))
  const a = createManagedPluginRegistry({ root }); const b = createManagedPluginRegistry({ root })
  try {
    await a.run((registry) => registry.addSource(fileURLToPath(new URL("./fixtures/marketplace-a", import.meta.url))))
    await a.run((registry) => registry.install("Marketplace A__hello"))
    await b.run((registry) => registry.enable("Marketplace A__hello"))
    expect(await a.run((registry) => registry.runtimeInputs())).toMatchObject({ commandDescriptors: expect.arrayContaining([expect.objectContaining({ name: "hello" })]) })
    await a.run((registry) => registry.disable("Marketplace A__hello"))
    expect((await b.run((registry) => registry.runtimeInputs())).commandDescriptors).toEqual([])
  } finally { await a.close(); await b.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) }
})
it("catches up once after watch events arrive during an active refresh", async () => {
  let listener: (event: { kind: "changed" | "reset" }) => void = () => {}
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe(fn) { listener = fn; return () => {} }, close: async () => {} }) })
  const observer = managed.observe(async () => { calls++; if (calls === 1) await held }, () => {})
  await vi.waitFor(() => expect(calls).toBe(1))
  listener({ kind: "changed" }); listener({ kind: "changed" })
  release()
  await vi.waitFor(() => expect(calls).toBe(2))
  await observer.close(); await managed.close()
})
it.each([undefined, null, false, 0, "", new Error("refresh")])("reports exact failure %s and retries on a subsequent event", async failure => {
  let listener!: (event: { kind: "changed" | "reset" } | { kind: "unavailable"; error: unknown }) => void
  const errors: unknown[] = []
  let calls = 0
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe(fn) { listener = fn; return () => {} }, close: async () => {} }) })
  const observer = managed.observe(async () => { if (++calls === 1) throw failure }, error => { errors.push(error) })
  await vi.waitFor(() => expect(errors).toEqual([failure]))
  expect(observer.status).toMatchObject({ failed: true, attempted: 1, applied: 0 })
  await new Promise(resolve => setImmediate(resolve)); expect(calls).toBe(1)
  listener({ kind: "changed" })
  await vi.waitFor(() => expect(calls).toBe(2))
  expect(observer.status).toMatchObject({ failed: false, attempted: 2, applied: 2 })
  await observer.close(); await managed.close()
})
it("retains a failed lease close for retry", async () => {
  let closes = 0
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe() { return () => {} }, async close() { if (++closes === 1) throw new Error("close failed") } }) })
  managed.observe(async () => {}, () => {})
  await expect(managed.close()).rejects.toThrow("cleanup failed")
  await managed.close()
  expect(closes).toBe(2)
})
it("refuses full close from the callback while allowing disposal", async () => {
  let observer!: ReturnType<ReturnType<typeof createManagedPluginRegistry>["observe"]>
  let result!: Promise<void>
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe() { return () => {} }, close: async () => {} }) })
  observer = managed.observe(async () => { await expect(observer.close()).rejects.toThrow("observer callback"); observer.dispose(); result = managed.close(); await expect(result).rejects.toThrow("observer callback") }, () => {})
  await vi.waitFor(() => expect(result).toBeDefined())
  await observer.close(); await managed.close()
})
it("does not refresh during ten minutes of healthy idle", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-plugin-idle-"))
  await writeFile(join(root, "state.json"), JSON.stringify({ version: 1, sources: [], plugins: [] }))
  const reads = vi.mocked(promises.readFile), stats = vi.mocked(syncFs.statSync)
  const managed = createManagedPluginRegistry({ root }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe() { return () => {} }, close: async () => {} }) })
  let calls = 0
  try {
    const observer = managed.observe(async () => { await managed.run(registry => registry.runtimeInputs()); calls++ }, () => {})
    await vi.waitFor(() => expect(calls).toBe(1))
    const baseline = [reads.mock.calls.length, stats.mock.calls.length]
    expect(baseline[0]).toBeGreaterThan(0)
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls).toBe(1)
    expect([reads.mock.calls.length, stats.mock.calls.length]).toEqual(baseline)
    await observer.close(); await managed.close()
  } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) }
})
it("reports unavailable coverage and refreshes on recovery reset", async () => {
  let listener!: (event: { kind: "changed" | "reset" } | { kind: "unavailable"; error: unknown }) => void
  const failure = new Error("unavailable")
  const errors: unknown[] = []; let calls = 0
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.reject(failure), subscribe(fn) { listener = fn; return () => {} }, close: async () => {} }) })
  const observer = managed.observe(async () => { calls++ }, error => { errors.push(error) })
  await vi.waitFor(() => expect(errors).toEqual([failure]))
  expect(calls).toBe(0)
  listener({ kind: "unavailable", error: false })
  expect(observer.status.coverage).toBe("unavailable")
  listener({ kind: "reset" })
  await vi.waitFor(() => expect(calls).toBe(1))
  expect(errors).toEqual([failure, false])
  expect(observer.status.coverage).toBe("covered")
  await observer.close(); await managed.close()
})
it("joins an accepted callback and exposes an error handler failure", async () => {
  let release!: () => void; let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { entered = resolve })
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe() { return () => {} }, close: async () => {} }) })
  const observer = managed.observe(async () => { entered(); await held; throw 0 }, () => { throw new Error("report failed") })
  await started
  let finished = false; const closing = observer.close().finally(() => { finished = true })
  await Promise.resolve(); expect(finished).toBe(false)
  release(); await expect(closing).rejects.toThrow("cleanup failed")
  await managed.close()
})
