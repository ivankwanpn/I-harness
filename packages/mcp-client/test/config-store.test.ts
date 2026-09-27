import { afterEach, expect, it } from "vitest"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpConfigStore } from "../src/config-store.ts"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
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
