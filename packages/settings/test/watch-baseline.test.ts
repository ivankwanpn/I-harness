import { afterEach, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path"
import { LayeredSettingsStore, type Settings } from "../src/index.ts"
import { controlledLease, settle } from "./helpers/settings-lease.ts"
vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, readFile: vi.fn(actual.readFile) } })

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), "ih-baseline-")); roots.push(root); const a = join(root, "a.json"), b = join(root, "b.json"); await writeFile(a, '{"fontSize":14}'); await writeFile(b, '{"model":"before"}'); return { a, b } }

it.each(["relative", "absolute"] as const)("initial reset preserves the committed baseline for a %s workspace auto source", async mode => {
  // Keep this fixture on the package volume: Windows cannot make a C: temp
  // directory relative to a D: checkout. Leave other package-local fixtures alone.
  const parent = resolve(process.cwd(), ".tmp")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "ih-workspace-baseline-"))
  try {
    expect(parse(root).root).toBe(parse(process.cwd()).root)
    expect(dirname(root)).toBe(parent)
    expect(isAbsolute(relative(process.cwd(), root))).toBe(false)
    await mkdir(join(root, ".i-harness"))
    const file = join(root, ".i-harness", "settings.json")
    await writeFile(file, '{"fontSize":14}')
    const workspace = mode === "relative" ? relative(process.cwd(), root) : root
    expect(isAbsolute(workspace)).toBe(mode === "absolute")
    const selectedSpelling = join(workspace, ".i-harness", "settings.json")
    const c = controlledLease(), paths: string[] = []
    const store = new LayeredSettingsStore({ roots: { workspace: "auto" }, workspace, watchService: c.service })
    const seam = store as unknown as { ensureWatcher(): void }, original = seam.ensureWatcher.bind(store)
    // Change real bytes after the initial read/publication, before acquisition.
    // Only an initial reset follows: a second construction read would hide this.
    vi.spyOn(seam, "ensureWatcher").mockImplementationOnce(() => {
      expect(store.get().fontSize).toBe(14)
      writeFileSync(file, '{"fontSize":15}')
      original()
    })
    store.onChange(path => { paths.push(path) })
    try {
      await store.load()
      expect(store.sources()[0]!.path).toBe(selectedSpelling)
      expect(store.get().fontSize).toBe(14)
      expect(await readFile(file, "utf8")).toBe('{"fontSize":15}')
      c.reset()
      await vi.waitFor(() => expect(store.get().fontSize).toBe(15))
      expect(paths).toEqual([selectedSpelling])
    } finally { await store.close() }
  } finally {
    const actualParent = await realpath(parent), actualRoot = await realpath(root)
    if (dirname(actualRoot) !== actualParent) throw new Error("Workspace baseline fixture escaped its owned temporary parent")
    await rm(actualRoot, { recursive: true, force: true })
  }
})

it("initial reset uses bytes committed by load, detecting B changed at the publication boundary", async () => {
  const { a, b } = await fixture(), c = controlledLease(), paths: string[] = []
  const store = new LayeredSettingsStore({ files: [a, b], watchService: c.service })
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  let release!: () => void
  vi.mocked(readFile).mockImplementation(async (...args: Parameters<typeof readFile>) => {
    const bytes = await actual.readFile(...args)
    if (args[0] === b && !release) await new Promise<void>(resolve => { release = resolve })
    return bytes
  })
  store.onChange(path => { paths.push(path) }); const loading = store.load()
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  await writeFile(b, '{"model":"after"}'); release(); await loading; c.reset()
  await vi.waitFor(() => expect(paths).toEqual([b])); expect(store.get().model).toBe("after"); await store.close()
})

it("close joins a previously accepted held set, and failed lease cleanup remains retryable", async () => {
  const { a } = await fixture(), c = controlledLease(), store = new LayeredSettingsStore({ files: [a], watchService: c.service })
  await store.load()
  const seam = store as unknown as { writeMaster(...args: unknown[]): Promise<void> }, original = seam.writeMaster.bind(store)
  let release!: () => void
  vi.spyOn(seam, "writeMaster").mockImplementation(async (...args) => { await new Promise<void>(resolve => { release = resolve }); await original(...args) })
  const writing = store.set({ fontSize: 15 }); await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  vi.mocked(c.lease.close).mockRejectedValueOnce(new Error("lease close"))
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
  const closing = store.close(); const rejected = closing.catch(error => error); let done = false; void rejected.then(() => { done = true })
  await settle(); expect(done).toBe(false); release(); await writing
  expect(await rejected).toBeInstanceOf(AggregateError); expect(store.get().fontSize).toBe(15)
  await store.close(); expect(c.lease.close).toHaveBeenCalledTimes(2); expect(c.service.close).not.toHaveBeenCalled(); warning.mockRestore()
})

it("an A event attributes a B-only source change to B and unchanged/hidden source changes stay quiet", async () => {
  const { a, b } = await fixture(), c = controlledLease(), paths: string[] = []
  const store = new LayeredSettingsStore({ files: [a, b], watchService: c.service })
  store.onChange(path => { paths.push(path) }); await store.load(); c.reset(); await settle(); expect(paths).toEqual([])
  await writeFile(b, '{"model":"after"}'); c.changed(a)
  await vi.waitFor(() => expect(paths).toEqual([b]))
  await writeFile(a, '{"fontSize":14,"model":"hidden"}'); c.changed(a); await settle(); expect(paths).toEqual([b]); await store.close()
})

it("unreadable or malformed layered reads retain the last committed state and recover on a new event", async () => {
  const { a, b } = await fixture(), c = controlledLease(), errors = vi.fn(), paths: string[] = []
  const store = new LayeredSettingsStore({ files: [a, b], watchService: c.service, onWatchError: errors })
  store.onChange(path => { paths.push(path) }); await store.load(); c.reset(); await settle()
  await rm(b); const { mkdir } = await import("node:fs/promises"); await mkdir(b)
  await expect(store.reloadFromDisk()).rejects.toBeDefined(); expect(store.get().model).toBe("before")
  await rm(b, { recursive: true }); await writeFile(b, '{broken'); c.changed(b)
  await vi.waitFor(() => expect(errors).toHaveBeenCalled()); expect(store.get().model).toBe("before"); expect(paths).toEqual([])
  await writeFile(b, '{"model":"after"}'); c.changed(b)
  await vi.waitFor(() => expect(paths).toEqual([b])); expect(store.get().model).toBe("after"); await store.close()
})

it("dispose fences held reload notifications, joins its read and rejects new operations", async () => {
  const { a, b } = await fixture(), c = controlledLease(), paths = vi.fn()
  const store = new LayeredSettingsStore({ files: [a, b], watchService: c.service })
  await store.load(); store.onChange(paths)
  const internal = store as unknown as { read(): Promise<Settings> }, original = internal.read.bind(store)
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const read = vi.spyOn(internal, "read").mockImplementation(async () => { const result = await original(); await gate; return result })
  await writeFile(a, '{"fontSize":15}'); c.changed(a); await vi.waitFor(() => expect(read).toHaveBeenCalled())
  store.dispose(); const closing = store.close(); expect(store.close()).toBe(closing)
  let done = false; void closing.then(() => { done = true }); await settle(); expect(done).toBe(false)
  await expect(store.load()).rejects.toThrow("closed"); await expect(store.reloadFromDisk()).rejects.toThrow("closed")
  await expect(store.set({ fontSize: 16 })).rejects.toThrow("closed"); await expect(store.reset()).rejects.toThrow("closed")
  release(); await closing; expect(paths).not.toHaveBeenCalled(); expect(c.service.close).not.toHaveBeenCalled()
})

it("isolates listener and telemetry failures, retaining changed-source notifications for other listeners", async () => {
  const { a, b } = await fixture(), c = controlledLease(), paths: string[] = [], errors = vi.fn()
  const store = new LayeredSettingsStore({ files: [a, b], watchService: c.service, onWatchError: errors,
    telemetry: { emit() { throw new Error("telemetry") }, close() {} } })
  store.onChange(() => { throw new Error("listener") }); store.onChange(path => { paths.push(path) })
  await store.load(); await writeFile(a, '{"fontSize":15}'); await writeFile(b, '{"model":"after"}'); c.changed(a)
  await vi.waitFor(() => expect(paths).toEqual([a, b])); expect(errors).toHaveBeenCalledTimes(4); await store.close()
})
