import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { createManagedPluginRegistry } from "../src/managed.ts"
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
it("reports falsey failures and retries on a subsequent event", async () => {
  let listener!: (event: { kind: "changed" | "reset" } | { kind: "unavailable"; error: unknown }) => void
  const errors: unknown[] = []
  let calls = 0
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe(fn) { listener = fn; return () => {} }, close: async () => {} }) })
  const observer = managed.observe(async () => { if (++calls === 1) throw undefined }, error => errors.push(error))
  await vi.waitFor(() => expect(errors).toEqual([undefined]))
  listener({ kind: "changed" })
  await vi.waitFor(() => expect(calls).toBe(2))
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
  observer = managed.observe(async () => { observer.dispose(); result = managed.close(); await expect(result).rejects.toThrow("observer callback") }, () => {})
  await vi.waitFor(() => expect(result).toBeDefined())
  await observer.close(); await managed.close()
})
it("does not refresh during ten minutes of healthy idle", async () => {
  vi.useFakeTimers()
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.resolve(), subscribe() { return () => {} }, close: async () => {} }) })
  let calls = 0
  try {
    const observer = managed.observe(async () => { calls++ }, () => {})
    await vi.advanceTimersByTimeAsync(600_000)
    expect(calls).toBe(1)
    await observer.close(); await managed.close()
  } finally { vi.useRealTimers() }
})
it("reports unavailable coverage and refreshes on recovery reset", async () => {
  let listener!: (event: { kind: "changed" | "reset" } | { kind: "unavailable"; error: unknown }) => void
  const failure = new Error("unavailable")
  const errors: unknown[] = []; let calls = 0
  const managed = createManagedPluginRegistry({ root: tmpdir() }, { acquireStateWatch: () => ({ ready: Promise.reject(failure), subscribe(fn) { listener = fn; return () => {} }, close: async () => {} }) })
  const observer = managed.observe(async () => { calls++ }, error => errors.push(error))
  await vi.waitFor(() => expect(errors).toEqual([failure]))
  expect(calls).toBe(0)
  listener({ kind: "reset" })
  await vi.waitFor(() => expect(calls).toBe(1))
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
