import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import type { FSWatcher } from "chokidar"
import fsPromises from "node:fs/promises"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { spawn } from "node:child_process"
import { createFsWatcher, createFsWatchService, type WatchLease, type WatchNotification } from "../src/index.ts"
import { watchdog } from "./helpers/push-watcher.ts"

const observed = vi.hoisted(() => ({ watchers: [] as FSWatcher[] }))
vi.mock("chokidar", async importOriginal => {
  const actual = await importOriginal<typeof import("chokidar")>()
  return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => {
    const watcher = actual.watch(...args)
    observed.watchers.push(watcher)
    watcher.on("all", (kind, path) => trace({ native: observed.watchers.indexOf(watcher), kind, path }))
    watcher.on("raw", (kind, path, details) => {
      // Record only this fixture's events; ancestors also receive unrelated OS noise.
      const watchedPath = (details as { watchedPath?: unknown } | undefined)?.watchedPath
      if (String(watchedPath).includes("ih-watch-routing-") || String(path).includes("ih-watch-routing-")) {
        trace({ raw: observed.watchers.indexOf(watcher), kind, path, details })
      }
    })
    return watcher
  } }
})
function trace(value: unknown) { if (process.env.W1_TRACE) console.log(JSON.stringify(value)) }
afterEach(() => { observed.watchers.length = 0; vi.restoreAllMocks(); syncBuiltinESMExports() })

async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "ih-watch-routing-"))
  return { root, async remove() {
    const target = resolve(root), parent = resolve(tmpdir()) + sep
    if (!target.startsWith(parent) || !target.slice(parent.length).startsWith("ih-watch-routing-")) throw new Error("Unsafe temporary cleanup")
    await rm(target, { recursive: true, force: true })
  } }
}

// Reads are caused only by lease notifications, never a probe loop. The watchdog
// reports source identity and every notification on failure.
function follow(lease: WatchLease, file: string) {
  const events: WatchNotification[] = []
  let state: string | null | undefined, job = Promise.resolve(), failure: unknown
  const waiting = new Set<{ expected: string | null; resolve: () => void }>()
  lease.subscribe(event => {
    events.push(event); trace({ notification: event })
    if (event.kind === "unavailable") return
    job = job.then(async () => {
      state = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null
        throw error
      })
      trace({ snapshot: file, state })
      for (const waiter of waiting) if (waiter.expected === state) { waiting.delete(waiter); waiter.resolve() }
    }).catch(error => { failure = error })
  })
  return { events, at(expected: string | null) {
    return new Promise<void>((yes, no) => {
      const timer = setTimeout(() => {
        waiting.delete(waiter)
        no(new Error(JSON.stringify({ expected, state, file, events, failure, watched: observed.watchers.map(w => w.getWatched()) })))
      }, 8000)
      const waiter = { expected, resolve: () => { clearTimeout(timer); yes() } }
      if (state === expected) waiter.resolve()
      else waiting.add(waiter)
    })
  }, async join() { await job; if (failure) throw failure } }
}

describe.skipIf(process.platform !== "win32")("real Windows selected-root routing", () => {
  it.each(["EPERM", "EIO"])("forwards nonpersistent Chokidar native errors (%s) to source failure", async code => {
    const temp = await temporary(), file = join(temp.root, "AGENTS.md")
    await writeFile(file, "before")
    const original = fs.watch, handles: Array<{ path: string; handle: fs.FSWatcher }> = []
    vi.spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
      const handle = original(...args); handles.push({ path: String(args[0]), handle }); return handle
    }) as typeof fs.watch)
    syncBuiltinESMExports()
    const watcher = createFsWatcher({ roots: [file], persistent: false })
    try {
      await watcher.ready
      const content = handles.find(({ path }) => resolve(path) === file)!.handle
      const result = watcher.events[Symbol.asyncIterator]().next().catch(error => error)
      expect(() => content.emit("error", Object.assign(new Error("injected native error"), { code }))).not.toThrow()
      expect(await watchdog(result)).toMatchObject({ code: "FS_WATCH_BACKEND" })
    } finally { await watcher.close(); await temp.remove() }
  })

  it("lets a ready nonpersistent combined source exit without explicit close", async () => {
    const temp = await temporary(), source = new URL("../src/index.ts", import.meta.url).href
    const script = `import { createFsWatchService } from ${JSON.stringify(source)};
      const service = createFsWatchService(); const lease = service.acquire({ roots: [${JSON.stringify(temp.root)}], persistent: false });
      await lease.ready; console.log('ready without explicit close');`
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.on("data", chunk => { output += chunk }); child.stderr.on("data", chunk => { output += chunk })
    try {
      const code = await watchdog(new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve) }), 8000)
      trace({ childExit: code, output })
      expect(code).toBe(0); expect(output).toContain("ready without explicit close")
    } finally { if (child.exitCode === null) child.kill(); await temp.remove() }
  })
  it("does not enumerate or stat unrelated routing-ancestor entries", async () => {
    const temp = await temporary(), selected = join(temp.root, "selected"), file = join(selected, "AGENTS.md")
    const unrelated = join(temp.root, "unrelated")
    await mkdir(selected); await mkdir(unrelated); await writeFile(file, "before")
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(unrelated, `entry-${i}`), "unrelated")))
    const originalWatch = fs.watch, handles: Array<{ path: string; closed: boolean }> = []
    vi.spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
      const handle = originalWatch(...args), entry = { path: String(args[0]), closed: false }
      handles.push(entry); handle.once("close", () => { entry.closed = true }); return handle
    }) as typeof fs.watch)
    const stats = vi.spyOn(fsPromises, "lstat"), reads = vi.spyOn(fsPromises, "readdir")
    syncBuiltinESMExports()
    const started = performance.now(), service = createFsWatchService()
    const lease = service.acquire({ roots: [file], persistent: false }), state = follow(lease, file)
    try {
      await lease.ready; await state.at("before")
      const statPaths = stats.mock.calls.map(([path]) => String(path))
      const readPaths = reads.mock.calls.map(([path]) => String(path))
      trace({ startupMs: performance.now() - started, lstatCount: statPaths.length, reads: readPaths, handles: handles.map(({ path }) => path), unrelatedStats: statPaths.filter(path => path.includes("unrelated")) })
      expect(statPaths).not.toContain(unrelated)
      expect(readPaths).not.toContain(temp.root)
      expect(readPaths).not.toContain(unrelated)
      expect(handles.every(({ path }) => file === resolve(path) || file.startsWith(resolve(path).replace(/[\\/]$/, "") + sep))).toBe(true)
    } finally { await service.close(); await state.join(); await temp.remove() }
    expect(handles.every(({ closed }) => closed)).toBe(true)
  }, 20000)
  it.each([true, false])("keeps ignored-parent rules observable after move/recreate and another write (persistent: %s)", async persistent => {
    const temp = await temporary(), root = join(temp.root, ".i-harness", "rules"), file = join(root, "AGENTS.md")
    await mkdir(root, { recursive: true }); await writeFile(join(root, "CLAUDE.md"), "fallback")
    const service = createFsWatchService()
    const lease = service.acquire({ roots: [root, file, join(root, "CLAUDE.md"), join(root, ".git")], persistent })
    const state = follow(lease, file)
    try {
      await lease.ready; await state.at(null)
      await writeFile(file, "preferred"); await state.at("preferred")
      await writeFile(join(root, "replacement"), "atomic"); await rename(join(root, "replacement"), file); await state.at("atomic")
      await rename(root, join(temp.root, ".i-harness", "retired")); await mkdir(root)
      await writeFile(file, "directory replacement"); await state.at("directory replacement")
      const owners = observed.watchers.length
      await writeFile(file, "later ordinary write"); await state.at("later ordinary write")
      expect(observed.watchers).toHaveLength(owners)
      expect(state.events.some(e => e.kind === "changed" || (e.kind === "reset" && e.reason === "recovered"))).toBe(true)
    } finally { await service.close(); await state.join(); await temp.remove() }
  }, 25000)

  it.each(["directory", "exact file", "ignored directory"])("restores a selected %s after parent delete/recreate", async selection => {
    const temp = await temporary(), root = selection === "ignored directory" ? join(temp.root, ".i-harness", "rules") : join(temp.root, "parent"), file = join(root, "AGENTS.md")
    await mkdir(root, { recursive: true }); await writeFile(file, "before")
    const roots = selection === "ignored directory" ? [root, file] : [selection === "directory" ? root : file]
    const service = createFsWatchService(), lease = service.acquire({ roots, persistent: false })
    const state = follow(lease, file)
    try {
      await lease.ready; await state.at("before")
      await rm(root, { recursive: true }); await state.at(null)
      await mkdir(root); await writeFile(file, "recreated"); await state.at("recreated")
      await writeFile(file, "follow-up"); await state.at("follow-up")
    } finally { await service.close(); await state.join(); await temp.remove() }
  }, 30000)

  it("discovers an initially missing multi-level ignored route and retains it", async () => {
    const temp = await temporary(), root = join(temp.root, ".i-harness", "nested", "rules"), file = join(root, "AGENTS.md")
    const service = createFsWatchService(), lease = service.acquire({ roots: [root, file], persistent: false })
    const state = follow(lease, file)
    try {
      await lease.ready; await state.at(null)
      await mkdir(root, { recursive: true }); await writeFile(file, "appeared"); await state.at("appeared")
      await writeFile(file, "follow-up"); await state.at("follow-up")
    } finally { await service.close(); await state.join(); await temp.remove() }
  }, 25000)

  it("retargets a selected junction then observes the new target's ordinary write", async () => {
    const temp = await temporary(), a = join(temp.root, "a"), b = join(temp.root, "b"), alias = join(temp.root, "alias")
    await mkdir(a); await mkdir(b); await writeFile(join(a, "AGENTS.md"), "first"); await writeFile(join(b, "AGENTS.md"), "second")
    await symlink(a, alias, "junction")
    const file = join(alias, "AGENTS.md"), service = createFsWatchService()
    const lease = service.acquire({ roots: [alias, file], persistent: false }), state = follow(lease, file)
    try {
      await lease.ready; await state.at("first")
      await unlink(alias); await symlink(b, alias, "junction"); await state.at("second")
      await writeFile(join(b, "AGENTS.md"), "new target follow-up"); await state.at("new target follow-up")
    } finally { await service.close(); await state.join(); await temp.remove() }
  }, 25000)

  it("prunes unrelated siblings and ignored descendants while retaining an explicit Git marker", async () => {
    const temp = await temporary(), root = join(temp.root, "selected"), file = join(root, "AGENTS.md")
    const sibling = join(temp.root, "unrelated"), git = join(root, ".git")
    await mkdir(root); await mkdir(sibling); await mkdir(git)
    await writeFile(file, "before"); await writeFile(join(sibling, "secret"), "unrelated")
    const service = createFsWatchService(), lease = service.acquire({ roots: [root, git], persistent: false })
    const state = follow(lease, file)
    try {
      await lease.ready; await state.at("before")
      const native = observed.watchers.at(-1)!, watched = native.getWatched()
      expect(watched[sibling]).toBeUndefined()
      expect(watched[dirname(root)]).not.toContain("unrelated")
      expect(watched[root]).toContain(".git")
      await writeFile(join(sibling, "secret"), "changed")
      await writeFile(join(git, "config"), "ignored")
      await writeFile(file, "barrier"); await state.at("barrier")
      expect(observed.watchers).toHaveLength(1)
      const paths = state.events.flatMap(event => event.kind === "changed" ? event.changes.map(change => change.path) : [])
      expect(paths).not.toContain(sibling); expect(paths).not.toContain(join(sibling, "secret")); expect(paths).not.toContain(join(git, "config"))
      expect(paths.every(path => path === root || path.startsWith(root + sep))).toBe(true)
    } finally { await service.close(); await state.join(); await temp.remove() }
  }, 20000)
})
