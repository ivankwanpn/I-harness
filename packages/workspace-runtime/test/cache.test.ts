import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, it, vi } from "vitest"
import { archive } from "./archive-fixture.ts"
import { acquireSessionLock } from "@i-harness/fs-lock"
// Replace only the fixed trust anchor with a controlled tar fixture. Production
// keeps its official constant; runtime.test exercises that constant's rejection.
vi.mock("../src/pin.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/pin.ts")>()
  const { archive } = await import("./archive-fixture.ts"), { createHash } = await import("node:crypto")
  return { ...actual, NODE_PIN: { ...actual.NODE_PIN, sha256: createHash("sha256").update(archive()).digest("hex") } }
})
import { createWorkspaceRuntime } from "../src/index.ts"

const configuration = { distribution: "Ubuntu", workspaceDependencies: true }
function owned() { mkdirSync(resolve(".tmp"), { recursive: true }); return mkdtempSync(resolve(".tmp/wsl-product-integration-cache-")) }
function fixture(cacheRoot: string) {
  const reads: string[][] = [], downloads: string[] = []
  const manager = createWorkspaceRuntime({ cacheRoot,
    inspectRuntime: async (_distribution, paths = []) => {
      reads.push([...paths]); return { available: true, detail: "controlled", dependencies: { python: { available: true }, bash: { available: true }, bubblewrap: { available: true }, node: { available: false }, npm: { available: false } },
        paths: paths.map(windows => ({ windows, linux: windows.replaceAll("\\", "/").replace(/^[A-Z]:/i, "/mnt/d") })) }
    },
    fetch: async input => { downloads.push(String(input)); return new Response(archive()) },
  })
  return { manager, reads, downloads }
}
function release(cacheRoot: string) { return join(cacheRoot, "releases", JSON.parse(readFileSync(join(cacheRoot, "current-v22.23.3-linux-x64.json"), "utf8")).release) }

it("atomically installs regular LF wrappers, maps captured cache/release/bin paths, and reuses a verified release", async () => {
  const root = owned(), cacheRoot = join(root, "cache"), { manager, reads, downloads } = fixture(cacheRoot)
  try {
    const result = await manager.resolve(configuration, { installIfMissing: true })
    expect(result).toMatchObject({ status: "available", source: "managed", nodeVersion: "22.23.3" })
    expect(Object.isFrozen(result.runtimePath)).toBe(true)
    const installed = release(cacheRoot)
    expect(reads.at(-1)).toEqual([cacheRoot, installed, join(installed, "bin")])
    const wrapper = readFileSync(join(installed, "bin/npm"), "utf8")
    expect(wrapper).toContain('exec "$basedir/node"'); expect(wrapper).not.toContain("\r")
    expect(await manager.resolve(configuration, { installIfMissing: true })).toEqual(result)
    expect(await manager.repair(configuration)).toEqual(result)
    expect(downloads).toHaveLength(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("refuses corrupt executable bytes despite unchanged identity metadata, and repairs into a new release", async () => {
  const root = owned(), cacheRoot = join(root, "cache"), { manager } = fixture(cacheRoot)
  try {
    await manager.repair(configuration)
    const original = release(cacheRoot), node = join(original, "bin/node")
    chmodSync(node, 0o644); writeFileSync(node, "forged executable")
    expect(await manager.diagnose(configuration)).toMatchObject({ status: "unavailable", detail: expect.stringContaining("integrity check failed") })
    expect(await manager.repair(configuration)).toMatchObject({ status: "available", source: "managed" })
    expect(release(cacheRoot)).not.toBe(original)
    expect(readFileSync(node, "utf8")).toBe("forged executable")
    expect(readFileSync(join(release(cacheRoot), "bin/node")).subarray(0, 4)).toEqual(Buffer.from([0x7f, 69, 76, 70]))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("refuses a hardlinked installed executable", async () => {
  const root = owned(), cacheRoot = join(root, "cache"), { manager } = fixture(cacheRoot)
  try {
    await manager.repair(configuration)
    linkSync(join(release(cacheRoot), "bin/node"), join(root, "node-alias"))
    expect(await manager.diagnose(configuration)).toMatchObject({ status: "unavailable", detail: expect.stringMatching(/linked|unsafe/) })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("never crosses a cache directory junction or reuses another cache's authority", async () => {
  const root = owned(), other = join(root, "other"), cacheRoot = join(root, "cache")
  mkdirSync(other)
  symlinkSync(other, cacheRoot, process.platform === "win32" ? "junction" : "dir")
  const { manager, downloads } = fixture(cacheRoot)
  try {
    await expect(manager.repair(configuration)).rejects.toThrow(/regular directory/)
    expect(downloads).toHaveLength(0)
    expect(await fixture(join(root, "isolated")).manager.diagnose(configuration)).toMatchObject({ status: "missing" })
  } finally { rmSync(cacheRoot); rmSync(root, { recursive: true, force: true }) }
})
it("aborted resolution never begins inspection or download", async () => {
  const root = owned(), { manager, reads, downloads } = fixture(join(root, "cache")), stop = new AbortController()
  stop.abort()
  try {
    await expect(manager.resolve(configuration, { installIfMissing: true, signal: stop.signal })).rejects.toThrow()
    expect(reads).toHaveLength(0); expect(downloads).toHaveLength(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it.skipIf(process.platform !== "win32")("repairs a corrupt readonly owned archive without changing an existing release", async () => {
  const root = owned(), cacheRoot = join(root, "cache"), { manager, downloads } = fixture(cacheRoot)
  try {
    await manager.repair(configuration)
    const original = release(cacheRoot), archiveFile = join(cacheRoot, "archives/node-v22.23.3-linux-x64.tar.gz")
    chmodSync(archiveFile, 0o600); writeFileSync(archiveFile, "corrupt owned archive"); chmodSync(archiveFile, 0o444)
    await expect(manager.repair(configuration)).resolves.toMatchObject({ status: "available", source: "managed" })
    expect(downloads).toHaveLength(2)
    expect(readFileSync(join(original, "bin/node")).subarray(0, 4)).toEqual(Buffer.from([0x7f, 69, 76, 70]))
    expect(await manager.diagnose(configuration)).toMatchObject({ status: "available", source: "managed" })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("two installers wait on the same owned lease and reuse one verified download", async () => {
  const root = owned(), cacheRoot = join(root, "cache"), base = fixture(cacheRoot)
  let entered!: () => void, releaseDownload!: () => void, downloads = 0
  const active = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { releaseDownload = resolve })
  const manager = createWorkspaceRuntime({ cacheRoot, inspectRuntime: async (_distribution, paths = []) => ({ available: true, detail: "controlled", dependencies: { python: { available: true }, bash: { available: true }, bubblewrap: { available: true } }, paths: paths.map(windows => ({ windows, linux: "/mnt/d/fixture/bin" })) }), fetch: async () => { downloads++; entered(); await waiting; return new Response(archive()) } })
  const first = manager.repair(configuration)
  await active
  const second = base.manager.repair(configuration)
  void second.catch(() => {})
  try {
    await new Promise(resolve => setTimeout(resolve, 40)); releaseDownload()
    await expect(Promise.all([first, second])).resolves.toEqual([expect.objectContaining({ status: "available" }), expect.objectContaining({ status: "available" })])
    expect(downloads).toBe(1); expect(base.downloads).toHaveLength(0)
  } finally { releaseDownload(); await Promise.allSettled([first, second]); rmSync(root, { recursive: true, force: true }) }
})
it("cancels an installer while another owner holds the cache lease without a late download", async () => {
  const root = owned(), cacheRoot = join(root, "cache"); mkdirSync(cacheRoot)
  const held = await acquireSessionLock({ lockPath: join(cacheRoot, "install.lock") })
  const { manager, downloads } = fixture(cacheRoot), stop = new AbortController()
  const pending = manager.repair(configuration, { signal: stop.signal })
  const observed = pending.then(() => ({ cancelled: false }), cause => ({ cancelled: cause.name === "AbortError" }))
  setTimeout(() => stop.abort(), 20)
  try {
    const result = await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 1500))])
    expect(result).toEqual({ cancelled: true }); expect(downloads).toHaveLength(0)
  } finally { await held.release(); await observed; rmSync(root, { recursive: true, force: true }) }
})
