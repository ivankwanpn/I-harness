import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import { createWorkspaceRuntime } from "../src/index.ts"

function owned() { mkdirSync(resolve(".tmp"), { recursive: true }); return mkdtempSync(resolve(".tmp/wsl-product-integration-runtime-")) }
function inspector(systemNode = false, usable = true) {
  return async (distribution: string, paths: readonly string[] = []) => ({ distribution, available: usable, detail: usable ? "controlled isolation" : "Missing system Python/Bash/bubblewrap",
    dependencies: Object.fromEntries(["python", "bash", "bubblewrap", "node", "npm", "git", "socat"].map(key => [key, { available: ["node", "npm"].includes(key) ? systemNode : usable }])),
    paths: paths.map(windows => ({ windows, linux: "/mnt/d/owned/bin" })),
  })
}
it("disabled workspace dependencies never download, inspect WSL or create the cache", async () => {
  const root = owned(), cacheRoot = resolve(root, "cache")
  let reads = 0, downloads = 0
  const manager = createWorkspaceRuntime({ cacheRoot, inspectRuntime: async () => { reads++; return inspector()!("Ubuntu") }, fetch: async () => { downloads++; return new Response("bad") } })
  try {
    const configuration = { distribution: "Ubuntu", workspaceDependencies: false }
    expect(await manager.resolve(configuration, { installIfMissing: true })).toMatchObject({ status: "disabled" })
    expect(await manager.diagnose(configuration)).toMatchObject({ status: "disabled" })
    expect(await manager.repair(configuration)).toMatchObject({ status: "disabled" })
    expect(reads).toBe(0); expect(downloads).toBe(0); expect(existsSync(cacheRoot)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("uses a usable system Node/npm without downloading an unnecessary managed runtime", async () => {
  const root = owned(); let downloads = 0
  const manager = createWorkspaceRuntime({ cacheRoot: resolve(root, "cache"), inspectRuntime: inspector(true), fetch: async () => { downloads++; return new Response("bad") } })
  try {
    expect(await manager.resolve({ distribution: "Ubuntu", workspaceDependencies: true }, { installIfMissing: true })).toMatchObject({ status: "available", source: "system" })
    expect(downloads).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("refuses a downloaded digest mismatch before cache promotion", async () => {
  const root = owned(), cacheRoot = resolve(root, "cache"); let downloads = 0
  const manager = createWorkspaceRuntime({ cacheRoot, inspectRuntime: inspector(), fetch: async () => { downloads++; return new Response("wrong artifact") } })
  try {
    await expect(manager.repair({ distribution: "Ubuntu", workspaceDependencies: true })).rejects.toThrow(/digest/i)
    expect(downloads).toBe(1)
    expect(existsSync(resolve(cacheRoot, "current-v22.23.3-linux-x64.json"))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("reports missing system prerequisites without attempting download", async () => {
  const root = owned(); let downloads = 0
  const manager = createWorkspaceRuntime({ cacheRoot: resolve(root, "cache"), inspectRuntime: inspector(false, false), fetch: async () => { downloads++; return new Response("bad") } })
  try {
    expect(await manager.resolve({ distribution: "Ubuntu", workspaceDependencies: true }, { installIfMissing: true })).toMatchObject({ status: "unavailable", detail: expect.stringMatching(/Python.*Bash.*bubblewrap/) })
    expect(downloads).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("reports a failed runtime inspection as unavailable without downloading", async () => {
  const root = owned(); let downloads = 0
  const manager = createWorkspaceRuntime({ cacheRoot: resolve(root, "cache"), inspectRuntime: async () => { throw new Error("Controlled WSL discovery failure") }, fetch: async () => { downloads++; return new Response("bad") } })
  try {
    await expect(manager.resolve({ distribution: "Ubuntu", workspaceDependencies: true }, { installIfMissing: true })).resolves.toMatchObject({ status: "unavailable", detail: expect.stringContaining("Controlled WSL discovery failure") })
    expect(downloads).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("aborts an active download through the captured caller signal without promoting a runtime", async () => {
  const root = owned(), cacheRoot = resolve(root, "cache"), stop = new AbortController()
  let entered!: () => void
  const downloading = new Promise<void>(resolve => { entered = resolve })
  const manager = createWorkspaceRuntime({ cacheRoot, inspectRuntime: inspector(), fetch: async (_input, init) => {
    const response = new Response(new ReadableStream({ start(controller) {
      init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true })
    } }))
    entered(); return response
  } })
  const pending = manager.repair({ distribution: "Ubuntu", workspaceDependencies: true }, { signal: stop.signal })
  try {
    await downloading; stop.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(existsSync(resolve(cacheRoot, "current-v22.23.3-linux-x64.json"))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it("refuses an oversized advertised download before consuming archive bytes", async () => {
  const root = owned(), cacheRoot = resolve(root, "cache")
  const manager = createWorkspaceRuntime({ cacheRoot, inspectRuntime: inspector(), fetch: async () => new Response("small", { headers: { "content-length": String(96 * 1024 * 1024 + 1) } }) })
  try {
    await expect(manager.repair({ distribution: "Ubuntu", workspaceDependencies: true })).rejects.toThrow(/download limit/)
    expect(existsSync(resolve(cacheRoot, "current-v22.23.3-linux-x64.json"))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
