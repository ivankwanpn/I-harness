import { afterEach, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as io from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchSettings } from "../src/index.ts"
import { controlledLease, settle } from "./helpers/settings-lease.ts"

const owner = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("@i-harness/fs-watch", async original => ({ ...await original<typeof import("@i-harness/fs-watch")>(), createFsWatchService: owner.create }))
vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) } })
vi.mock("node:fs", async original => { const actual = await original<typeof import("node:fs")>(); return { ...actual, readFileSync: vi.fn(actual.readFileSync), statSync: vi.fn(actual.statSync) } })
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await io.rm(root, { recursive: true, force: true }) })
async function fixture() { const root = await io.mkdtemp(join(tmpdir(), "ih-watch-io-")); roots.push(root); const a = join(root, "a.json"); await io.writeFile(a, "aaaa"); return a }

it("does no healthy idle reads/stats or intervals and detects different bytes under identical stat metadata", async () => {
  const a = await fixture(), c = controlledLease(), changed: string[] = []
  const watcher = watchSettings(a, path => { changed.push(path) }, { service: c.service })
  c.reset(); await settle(); vi.mocked(io.readFile).mockClear(); vi.mocked(io.stat).mockClear(); vi.mocked(fs.statSync).mockClear()
  const interval = vi.spyOn(globalThis, "setInterval")
  await settle(); expect(io.readFile).not.toHaveBeenCalled(); expect(io.stat).not.toHaveBeenCalled(); expect(fs.statSync).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled()
  const metadata = await io.stat(a); vi.mocked(io.stat).mockResolvedValue(metadata); vi.mocked(fs.statSync).mockReturnValue(metadata)
  await io.writeFile(a, "bbbb"); c.reset("overflow"); await vi.waitFor(() => expect(changed).toEqual([a])); await watcher.close()
})

it("a same-path event arriving during a held byte read remains a separate pending snapshot", async () => {
  const a = await fixture(), c = controlledLease(), changed: string[] = []
  const watcher = watchSettings(a, path => { changed.push(path) }, { service: c.service })
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  let release!: () => void, started = false
  vi.mocked(io.readFile).mockImplementationOnce(async (...args: Parameters<typeof io.readFile>) => {
    const bytes = await actual.readFile(...args); started = true
    await new Promise<void>(resolve => { release = resolve }); return bytes
  })
  c.changed(a); await vi.waitFor(() => expect(started).toBe(true)); await io.writeFile(a, "bbbb"); c.changed(a)
  release(); await vi.waitFor(() => expect(changed).toEqual([a, a])); await watcher.close()
})

it("close joins a held read but does not admit its eventual callback", async () => {
  const a = await fixture(), c = controlledLease(), changed = vi.fn()
  const watcher = watchSettings(a, changed, { service: c.service })
  let release!: () => void
  vi.mocked(io.readFile).mockImplementationOnce(() => new Promise<Buffer<ArrayBuffer>>(resolve => { release = () => resolve(Buffer.from("bbbb")) }))
  c.changed(a); await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  const closing = watcher.close(); let done = false; void closing.then(() => { done = true }); await settle(); expect(done).toBe(false)
  release(); await closing; expect(changed).not.toHaveBeenCalled()
})

it("owned service and lease cleanup are joined, failures retained, and empty selection constructs no service", async () => {
  const a = await fixture(), c = controlledLease(); owner.create.mockReturnValue(c.service)
  vi.mocked(c.service.close).mockRejectedValueOnce(new Error("owner close"))
  const watcher = watchSettings(a, () => {})
  await expect(watcher.close()).rejects.toBeInstanceOf(AggregateError)
  expect(c.lease.close).toHaveBeenCalledOnce(); await watcher.close(); expect(c.service.close).toHaveBeenCalledTimes(2)
  owner.create.mockClear(); const empty = watchSettings([], () => {}); await expect(empty.ready).rejects.toMatchObject({ code: "FS_WATCH_CAPACITY" })
  await empty.close(); expect(owner.create).not.toHaveBeenCalled()
})

it("an owned service is retained for cleanup when acquire throws", async () => {
  const c = controlledLease(); owner.create.mockReturnValue(c.service); vi.mocked(c.service.acquire).mockImplementation(() => { throw new Error("acquire") })
  const watcher = watchSettings("missing.json", () => {}); await expect(watcher.ready).rejects.toThrow("acquire"); await watcher.close(); expect(c.service.close).toHaveBeenCalledOnce()
})
