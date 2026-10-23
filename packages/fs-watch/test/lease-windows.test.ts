import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { spawn } from "node:child_process"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import type { FSWatcher } from "chokidar"
import { createFsWatcher, createFsWatchService, type WatchNotification, type WatchLease } from "../src/index.ts"
import { gate, watchdog } from "./helpers/push-watcher.ts"

// Actual chokidar instances and filesystem event delivery. Only the labeled
// recovery test injects an error/holds close at this real construction boundary.
const observed = vi.hoisted(() => ({ watchers: [] as FSWatcher[] }))
vi.mock("chokidar", async importOriginal => {
  const actual = await importOriginal<typeof import("chokidar")>()
  return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => {
    const watcher = actual.watch(...args); observed.watchers.push(watcher); return watcher
  } }
})
afterEach(() => { observed.watchers.length = 0; vi.restoreAllMocks(); syncBuiltinESMExports() })
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "ih-watch-lease-"))
  return { root, async remove() {
    const absolute = resolve(root), parent = resolve(tmpdir()) + sep
    if (!isAbsolute(root) || !absolute.startsWith(parent) || !absolute.slice(parent.length).startsWith("ih-watch-lease-")) throw new Error("Unsafe temporary cleanup target")
    await rm(absolute, { recursive: true, force: true })
  } }
}
function capture(lease: WatchLease) {
  const events: WatchNotification[] = []
  const waiters = new Set<{ predicate: (event: WatchNotification) => boolean; resolve: (event: WatchNotification) => void }>()
  lease.subscribe(event => {
    events.push(event)
    for (const waiter of [...waiters]) if (waiter.predicate(event)) { waiters.delete(waiter); waiter.resolve(event) }
  })
  return { events, next(predicate: (event: WatchNotification) => boolean) {
    return watchdog(new Promise<WatchNotification>(resolve => waiters.add({ predicate, resolve })), 8000)
  } }
}
const changed = (path: string, kind?: string) => (event: WatchNotification) => event.kind === "changed"
  && event.changes.some(change => change.path === path && (!kind || change.kind === kind))

/** Minimal real consumer: every invalidation schedules a serialized resnapshot.
 * Resets reread every selected file, including files with no reliable deltas. */
function snapshots(lease: WatchLease, paths: string[]) {
  const state = new Map<string, string | null>()
  const waiting = new Set<{ expected: Array<[string, string | null]>; resolve: () => void }>()
  let job = Promise.resolve(), error: unknown
  lease.subscribe(event => {
    if (event.kind === "unavailable") return
    job = job.then(async () => {
      for (const path of paths) state.set(path, await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      }))
      for (const waiter of [...waiting]) if (waiter.expected.every(([path, value]) => state.get(path) === value)) {
        waiting.delete(waiter); waiter.resolve()
      }
    }).catch(cause => { error = cause })
  })
  return { state, async at(expected: Array<[string, string | null]>) {
    await watchdog(new Promise<void>(resolve => {
      if (expected.every(([path, value]) => state.get(path) === value)) resolve()
      else waiting.add({ expected, resolve })
    }), 8000)
    if (error) throw error
  }, async join() { await job; if (error) throw error } }
}

describe.skipIf(process.platform !== "win32")("real Windows native watch leases", () => {
  it("shares one backend, delivers to both leases, and keeps another service independent", async () => {
    const temp = await temporary(), file = join(temp.root, "shared.txt")
    const service = createFsWatchService(), other = createFsWatchService()
    const a = service.acquire({ roots: [temp.root], persistent: false }), b = service.acquire({ roots: [temp.root], persistent: false })
    const control = other.acquire({ roots: [temp.root], persistent: false })
    const left = capture(a), right = capture(b), independent = capture(control)
    try {
      await Promise.all([a.ready, b.ready, control.ready])
      expect(observed.watchers).toHaveLength(2)
      const adds = [left.next(changed(file, "add")), right.next(changed(file, "add")), independent.next(changed(file, "add"))]
      await writeFile(file, "one"); await Promise.all(adds)
      await a.close()
      const updates = [right.next(changed(file, "change")), independent.next(changed(file, "change"))]
      await writeFile(file, "two"); await Promise.all(updates)
      expect(left.events.flatMap(event => event.kind === "changed" ? event.changes : []).filter(change => change.path === file)).toEqual([{ path: file, kind: "add" }])
      await service.close()
      const last = independent.next(changed(file)); await writeFile(file, "three"); await last
    } finally { await service.close(); await other.close(); await temp.remove() }
  })

  it("resnapshots startup writes, missing ignored parents, recreation, atomic replace and truncate→write", async () => {
    const temp = await temporary(), parent = join(temp.root, ".i-harness"), file = join(parent, "settings.json")
    const startupFile = join(temp.root, "startup.txt")
    const service = createFsWatchService(), lease = service.acquire({ roots: [file, parent, startupFile], persistent: false })
    const state = snapshots(lease, [file, startupFile])
    try {
      // This write intentionally overlaps initial asynchronous native setup.
      await writeFile(startupFile, "during startup")
      await lease.ready; await state.at([[startupFile, "during startup"], [file, null]])
      await mkdir(parent); await writeFile(file, "one"); await state.at([[file, "one"]])
      await unlink(file); await state.at([[file, null]])
      await writeFile(file, "two"); await state.at([[file, "two"]])
      const replacement = join(parent, "replacement.json")
      await writeFile(replacement, "atomic"); await rename(replacement, file); await state.at([[file, "atomic"]])
      await writeFile(file, ""); await pause(30); await writeFile(file, "complete")
      await state.at([[file, "complete"]])
      expect(await readFile(file, "utf8")).toBe("complete")
    } finally { await service.close(); await state.join(); await temp.remove() }
  })

  it("converges a rapid many-file burst using actual changed/reset notifications", async () => {
    const temp = await temporary(), service = createFsWatchService()
    const files = Array.from({ length: 300 }, (_, i) => join(temp.root, `file-${i}.txt`))
    const lease = service.acquire({ roots: [temp.root], persistent: false }), state = snapshots(lease, files)
    const notifications = capture(lease)
    try {
      await lease.ready
      await Promise.all(files.map((file, i) => writeFile(file, String(i))))
      await state.at(files.map((file, i) => [file, String(i)]))
      expect(notifications.events.some(event => event.kind === "changed" || (event.kind === "reset" && event.reason === "overflow"))).toBe(true)
      expect(observed.watchers).toHaveLength(1)
    } finally { await service.close(); await state.join(); await temp.remove() }
  }, 20_000)

  it("hybrid fault injection: held real close blocks reopen; recovered reset resnapshots outage writes", async () => {
    const temp = await temporary(), service = createFsWatchService()
    const changedFile = join(temp.root, "changed.txt"), deletedFile = join(temp.root, "deleted.txt"), recreatedFile = join(temp.root, "recreated.txt")
    await Promise.all([changedFile, deletedFile, recreatedFile].map(file => writeFile(file, "before")))
    const lease = service.acquire({ roots: [temp.root], persistent: false }), events = capture(lease)
    const state = snapshots(lease, [changedFile, deletedFile, recreatedFile])
    const hold = gate()
    let closing: Promise<void> | undefined
    try {
      await lease.ready; await state.at([[changedFile, "before"], [deletedFile, "before"], [recreatedFile, "before"]])
      const native = observed.watchers[0]!, actualClose = native.close.bind(native)
      vi.spyOn(native, "close").mockImplementation(() => {
        closing ??= actualClose().then(() => hold.promise)
        return closing
      })
      const unavailable = events.next(event => event.kind === "unavailable")
      native.emit("error", new Error("injected native error callback")); await unavailable
      await writeFile(changedFile, "during outage"); await unlink(deletedFile)
      await unlink(recreatedFile); await writeFile(recreatedFile, "recreated during outage")
      expect(observed.watchers).toHaveLength(1)
      const recovered = events.next(event => event.kind === "reset" && event.reason === "recovered")
      hold.resolve(); await recovered
      await state.at([[changedFile, "during outage"], [deletedFile, null], [recreatedFile, "recreated during outage"]])
      expect(observed.watchers).toHaveLength(2)
    } finally { hold.resolve(); await service.close(); await state.join(); await temp.remove() }
  })

  it("observes a quiet real interval with native options and no stabilization probes", async () => {
    const recurrentProbes = vi.spyOn(fs, "watchFile")
    const statProbes = vi.spyOn(fs, "stat")
    syncBuiltinESMExports()
    const temp = await temporary(), w = createFsWatcher({ roots: [temp.root], persistent: false })
    const native = observed.watchers[0]!
    const stabilization = vi.spyOn(native as unknown as { _awaitWriteFinish: (...args: unknown[]) => void }, "_awaitWriteFinish")
    let count = 0
    const drain = (async () => { for await (const _event of w.events) count++ })()
    try {
      await w.ready
      expect(native.options).toMatchObject({ usePolling: false, awaitWriteFinish: false, persistent: false })
      const next = new Promise<void>(resolve => native.once("all", () => resolve()))
      await writeFile(join(temp.root, "probe.txt"), "one"); await next
      await pause(200)
      const before = count
      const beforeStats = statProbes.mock.calls.length
      await pause(250)
      expect(count).toBe(before); expect(stabilization).not.toHaveBeenCalled()
      expect(recurrentProbes).not.toHaveBeenCalled()
      expect(statProbes).toHaveBeenCalledTimes(beforeStats)
      expect(observed.watchers).toHaveLength(1)
    } finally { await w.close(); await drain; await temp.remove() }
  })
})

it("refuses environment-forced polling in an isolated child before opening native handles", async () => {
  const source = new URL("../src/index.ts", import.meta.url).href
  const script = `import { createFsWatcher, createFsWatchService } from ${JSON.stringify(source)};
    let timers = 0; const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (...args) => { timers++; return originalTimeout(...args) };
    try { createFsWatcher({ roots: ['missing'], persistent: false }); process.exitCode = 2 }
    catch (error) { console.log(error.code) }
    const owner = createFsWatchService(); const lease = owner.acquire({ roots: ['missing'], persistent: false });
    lease.subscribe(event => console.log(event.kind, event.code));
    try { await lease.ready } catch(error) { console.log('ready', error.code) }
    await owner.close(); console.log('scheduled timers', timers);`
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    windowsHide: true, env: { ...process.env, CHOKIDAR_USEPOLLING: "true" }, stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout.on("data", chunk => { output += chunk }); child.stderr.on("data", chunk => { output += chunk })
  try {
    const code = await watchdog(new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve) }), 8000)
    expect(code).toBe(0); expect(output).toContain("FS_WATCH_POLLING")
    expect(output).toContain("ready FS_WATCH_POLLING"); expect(output).toContain("unavailable FS_WATCH_POLLING")
    expect(output).toContain("scheduled timers 0")
  } finally { if (child.exitCode === null) child.kill() }
})
