import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rm, writeFile, unlink, utimes, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { watchSettings, type SettingsWatchError } from "../src/index.ts"

import { controlledLease, settle } from "./helpers/settings-lease.ts"
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), "ih-lease-")); roots.push(root); const a = join(root, "a.json"), b = join(root, "b.json"); await writeFile(a, "aaaa"); await writeFile(b, "bbbb"); return { a, b } }

it("acquires exactly selected absolute files, subscribes before readiness and ignores numeric timing", async () => {
  const c = controlledLease(), paths: string[] = []
  const timer = vi.spyOn(globalThis, "setTimeout"), interval = vi.spyOn(globalThis, "setInterval")
  const watcher = watchSettings("missing-settings.json", path => { paths.push(path) }, { service: c.service, intervalMs: 60000 })
  expect(c.service.acquire).toHaveBeenCalledExactlyOnceWith({ roots: [resolve("missing-settings.json")], persistent: false })
  expect(c.lease.subscribe).toHaveBeenCalledOnce()
  expect(timer).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled()
  c.reset(); await watcher.ready
  c.changed(resolve("missing-settings.json"), resolve("sibling.json")); await settle()
  expect(paths).toEqual(["missing-settings.json"])
  await watcher.close(); expect(c.service.close).not.toHaveBeenCalled()
})

it("reconciles initial/recovered/overflow snapshots using exact bytes even with restored metadata", async () => {
  const { a, b } = await fixture(), c = controlledLease(), paths: string[] = []
  const watcher = watchSettings([a, b], path => { paths.push(path) }, { service: c.service })
  c.reset(); await watcher.ready; await settle(); expect(paths).toEqual([])
  const metadata = await stat(a); await writeFile(a, "cccc"); await utimes(a, metadata.atime, metadata.mtime)
  c.reset("overflow"); await settle(); expect(paths).toEqual([a])
  await unlink(b); c.reset("recovered"); await settle(); expect(paths).toEqual([a, b])
  c.reset("subscribe"); await settle(); expect(paths).toEqual([a, b]); await watcher.close()
})

it("keeps recovery subscription after initial ready rejection", async () => {
  const { a } = await fixture(), c = controlledLease(), paths: string[] = []
  const watcher = watchSettings(a, path => { paths.push(path) }, { service: c.service })
  const error = new Error("failed readiness")
  c.emit({ kind: "unavailable", code: "FS_WATCH_GAP", cursor: c.cursor }); c.rejectReady(error)
  await expect(watcher.ready).rejects.toBe(error)
  expect(watcher.getState().kind).toBe("unavailable")
  await writeFile(a, "changed"); c.reset("recovered"); await settle()
  expect(watcher.getState().kind).toBe("covered"); expect(paths).toEqual([a]); await watcher.close()
})

it.each([false, true])("isolates throwing/rejecting consumers and uses safe fallback diagnostics (async=%s)", async asynchronous => {
  const { a, b } = await fixture(), c = controlledLease(), paths: string[] = []
  const secret = { get message() { throw new Error("SENTINEL SECRET") }, toString() { throw new Error("SENTINEL SECRET") } }
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const watcher = watchSettings([a, b], path => { paths.push(path); if (path === a) { if (asynchronous) return Promise.reject(secret); throw secret } }, { service: c.service })
  c.changed(a, b); await settle()
  expect(paths).toEqual([a, b]); expect(warning).toHaveBeenCalledTimes(1)
  expect(warning.mock.calls.flat().every(value => typeof value === "string" && !value.includes("SECRET"))).toBe(true)
  await watcher.close()
})

it("joins accepted callbacks, fences immediately, and retries failed lease cleanup", async () => {
  const { a } = await fixture(), c = controlledLease(); let release!: () => void
  const callback = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const onError = vi.fn(); const watcher = watchSettings(a, callback, { service: c.service, onError })
  c.changed(a); await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
  vi.mocked(c.lease.close).mockRejectedValueOnce(new Error("close failed"))
  const closing = watcher.close(); expect(watcher.close()).toBe(closing)
  let settled = false; void closing.catch(() => {}).finally(() => { settled = true })
  c.changed(a); await settle(); expect(settled).toBe(false); expect(callback).toHaveBeenCalledOnce()
  release(); await expect(closing).rejects.toBeInstanceOf(AggregateError)
  expect(onError).not.toHaveBeenCalled(); expect(watcher.getState()).toEqual({ kind: "closed" })
  await watcher.close(); expect(c.lease.close).toHaveBeenCalledTimes(2); expect(c.service.close).not.toHaveBeenCalled()
})

it.each([false, true])("a consumer can await its own close without joining itself (after await=%s)", async asynchronous => {
  const { a } = await fixture(), c = controlledLease(); let finished = false
  const watcher = watchSettings(a, async () => { if (asynchronous) await Promise.resolve(); await watcher.close(); finished = true }, { service: c.service })
  c.changed(a); await vi.waitFor(() => expect(finished).toBe(true)); expect(c.lease.close).toHaveBeenCalledOnce()
})

it("status snapshots are defensive and listener rejection cannot block another listener", async () => {
  const c = controlledLease(), onError = vi.fn(), states: string[] = []
  const watcher = watchSettings("missing.json", () => {}, { service: c.service, onError })
  watcher.subscribeState(() => Promise.reject(new Error("listener")))
  const unsubscribe = watcher.subscribeState(state => { states.push(state.kind); if (state.kind === "covered") (state.cursor as { epoch: number }).epoch = 999 })
  c.reset(); await watcher.ready; await settle()
  expect(states).toEqual(["starting", "covered"]); expect(watcher.getState()).toEqual({ kind: "covered", cursor: c.cursor })
  expect(onError).toHaveBeenCalledTimes(2); unsubscribe(); await watcher.close(); expect(states).toEqual(["starting", "covered"])
})

it("reports acquire failure without throwing or retrying and rejects empty selection", async () => {
  const c = controlledLease(); vi.mocked(c.service.acquire).mockImplementation(() => { throw new Error("acquire") })
  const watcher = watchSettings("missing.json", () => {}, { service: c.service })
  await expect(watcher.ready).rejects.toThrow("acquire"); expect(watcher.getState()).toMatchObject({ kind: "unavailable" })
  await settle(); expect(c.service.acquire).toHaveBeenCalledOnce(); await watcher.close()
  const empty = watchSettings([], () => {}, { service: c.service }); await expect(empty.ready).rejects.toMatchObject({ code: "FS_WATCH_CAPACITY" }); await empty.close()
})

it("unreadable transitions retain the original read error, invalidate, and recover independently", async () => {
  const { a, b } = await fixture(), c = controlledLease(), paths: string[] = [], onError = vi.fn()
  const watcher = watchSettings([a, b], path => { paths.push(path) }, { service: c.service, onError })
  await unlink(a); await mkdir(a); await writeFile(b, "changed"); c.reset()
  await vi.waitFor(() => expect(paths).toEqual([a, b]))
  expect(onError).toHaveBeenCalledOnce()
  // The original OS read error supplies errno/syscall, not a fabricated error.
  expect(onError.mock.calls[0]![0].error).toMatchObject({ code: "EISDIR", syscall: "read" })
  expect(watcher.getState().kind).toBe("covered")
  c.reset("overflow"); await settle(); expect(paths).toEqual([a, b])
  await rm(a, { recursive: true }); c.reset("recovered"); await vi.waitFor(() => expect(paths).toEqual([a, b, a]))
  await watcher.close()
})

it("repeated dispose observes a failed close only once and preserves it for retry", async () => {
  const c = controlledLease(), warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.mocked(c.lease.close).mockRejectedValueOnce(new Error("close"))
  const watcher = watchSettings("missing.json", () => {}, { service: c.service })
  watcher.dispose(); watcher.dispose(); await settle()
  expect(warning).toHaveBeenCalledTimes(1); await watcher.close()
})

it("a rejecting diagnostic hook is observed without recursive reporting or secret text", async () => {
  const { a } = await fixture(), c = controlledLease(), warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const original = new Error("SENTINEL SECRET"), onError = vi.fn((_failure: SettingsWatchError) => Promise.reject(original))
  const watcher = watchSettings(a, () => { throw original }, { service: c.service, onError })
  c.changed(a); await settle(); expect(onError).toHaveBeenCalledOnce(); expect(onError.mock.calls[0]![0]).toMatchObject({ error: original })
  expect(warning.mock.calls).toEqual([["[settings] watch consumer failed"]]); await watcher.close()
})

it("an external close can be followed by a held callback requesting that same close", async () => {
  const { a } = await fixture(), c = controlledLease(); let release!: () => void, entered = false, done = false
  const watcher = watchSettings(a, async () => { entered = true; await new Promise<void>(resolve => { release = resolve }); await watcher.close(); done = true }, { service: c.service })
  c.changed(a); await vi.waitFor(() => expect(entered).toBe(true))
  const closing = watcher.close(); release(); await closing; await vi.waitFor(() => expect(done).toBe(true))
})
