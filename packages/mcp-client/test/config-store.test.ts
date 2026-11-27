import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, open, readFile, readdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpConfigStore } from "../src/config-store.ts"

const probe = vi.hoisted(() => ({ rename: undefined as ((source: string, target: string, perform: () => Promise<void>) => Promise<void>) | undefined }))
vi.mock("node:fs/promises", async load => {
  const original = await load<typeof import("node:fs/promises")>()
  return { ...original, rename: (...args: Parameters<typeof original.rename>) =>
    probe.rename ? probe.rename(String(args[0]), String(args[1]), () => original.rename(...args)) : original.rename(...args) }
})

const roots: string[] = []
afterEach(async () => {
  probe.rename = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it("keeps private values out of listings and preserves them across public edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-mcp-config-")); roots.push(root)
  const store = createMcpConfigStore(join(root, "servers.json"))
  await store.save({ transport: "stdio", serverName: "local", command: "node", args: ["server.js"] }, { env: { TOKEN: "private-value" } })
  expect(JSON.stringify(await store.list())).not.toContain("private-value")
  expect(await store.active()).toEqual([])
  await store.setEnabled("local", true)
  await store.save({ transport: "stdio", serverName: "local", command: "node", args: ["new.js"] })
  expect(await store.active()).toMatchObject([{ args: ["new.js"], env: { TOKEN: "private-value" } }])
  await store.save({ transport: "stdio", serverName: "local", command: "node", args: [] }, { env: { TOKEN: null } })
  expect(JSON.stringify(await store.active())).not.toContain("TOKEN")
  await expect(store.save({ transport: "stdio", serverName: "plugin:reserved", command: "node", args: [] })).rejects.toThrow()
  await expect(store.save({ transport: "stdio", serverName: "local", command: "bad", args: [] }, undefined, 0)).rejects.toThrow("changed")
  await store.save({ transport: "streamable-http", serverName: "http", url: "http://127.0.0.1:9999/mcp" }, { headers: { Authorization: "private-header" } })
  expect(JSON.stringify(await store.list())).not.toContain("private-header")
})
it("serializes independent writers and refuses damaged settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-mcp-config-")); roots.push(root)
  const path = join(root, "servers.json"), a = createMcpConfigStore(path), b = createMcpConfigStore(path)
  await Promise.all([a.save({ transport: "stdio", serverName: "a", command: "node", args: [] }), b.save({ transport: "streamable-http", serverName: "b", url: "http://127.0.0.1:9999/mcp" })])
  expect(await a.list()).toHaveLength(2)
  await writeFile(path, "broken")
  await expect(a.remove("a")).rejects.toThrow()
  expect(await readFile(path, "utf8")).toBe("broken")
})

it("rejects an overflowing merged private map without damaging the document", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-mcp-config-")); roots.push(root)
  const path = join(root, "servers.json"), store = createMcpConfigStore(path)
  const config = { transport: "stdio", serverName: "bounded", command: "node", args: [] }
  await store.save(config, { env: Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`K${index}`, "value"])) })
  const before = await readFile(path, "utf8")
  await expect(store.save(config, { env: { ONE_MORE: "value" } })).rejects.toThrow("Too many")
  expect(await readFile(path, "utf8")).toBe(before)
  expect((await store.list())[0]!.secretKeys).toHaveLength(128)
})

async function replaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-mcp-config-")); roots.push(root)
  const path = join(root, "mcp-servers.json"), store = createMcpConfigStore(path)
  await store.save({ transport: "stdio", serverName: "fixture", command: "node", args: [] })
  return { root, path, store, before: await readFile(path, "utf8"), files: await readdir(root) }
}

it.skipIf(process.platform !== "win32")("replaces the same completed stage when a real reader releases the original file", async () => {
  const f = await replaceFixture(), reader = await open(f.path, "r")
  const stages: string[] = []
  let blocked = false
  probe.rename = async (source, target, perform) => {
    stages.push(source)
    expect(target).toBe(f.path)
    try { await perform() }
    catch (error) {
      expect(error).toMatchObject({ code: expect.stringMatching(/^(EPERM|EBUSY)$/), syscall: "rename" })
      expect(await reader.readFile("utf8")).toBe(f.before)
      expect(JSON.parse(await readFile(source, "utf8")).servers[0].enabled).toBe(true)
      blocked = true
      await reader.close()
      throw error
    }
  }
  try {
    await expect(f.store.setEnabled("fixture", true)).resolves.toMatchObject({ enabled: true, revision: 1 })
    expect(stages).toHaveLength(blocked ? 2 : 1)
    expect(new Set(stages).size).toBe(1)
    expect((await f.store.list())[0]).toMatchObject({ enabled: true, revision: 1 })
    expect(await readdir(f.root)).toEqual(f.files)
  } finally { await reader.close() }
})

it.skipIf(process.platform !== "win32").each(["EPERM", "EBUSY"])("preserves the old file and removes the stage after persistent Windows %s", async code => {
  const f = await replaceFixture(), failure = Object.assign(new Error("Persistent sharing window"), { code })
  const stages: string[] = []
  probe.rename = async source => { stages.push(source); throw failure }
  const started = performance.now()
  await expect(f.store.setEnabled("fixture", true)).rejects.toBe(failure)
  expect(performance.now() - started).toBeLessThan(2_000)
  expect(stages.length).toBeGreaterThan(1)
  expect(new Set(stages).size).toBe(1)
  expect(await readFile(f.path, "utf8")).toBe(f.before)
  expect(await readdir(f.root)).toEqual(f.files)
})

it.each(["EACCES", "EIO", ...(process.platform === "win32" ? [] : ["EPERM", "EBUSY"])])("does not retry unchanged native %s failures", async code => {
  const f = await replaceFixture(), failure = Object.assign(new Error("Original rename error"), { code })
  let attempts = 0
  probe.rename = async () => { attempts++; throw failure }
  await expect(f.store.setEnabled("fixture", true)).rejects.toBe(failure)
  expect(attempts).toBe(1)
  expect(await readFile(f.path, "utf8")).toBe(f.before)
  expect(await readdir(f.root)).toEqual(f.files)
})
