import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { assertServerName, validateMcpConfig } from "@i-harness/mcp-client"
import { installPlugin, PluginRegistry, readMcpServers, readMcpServersSync } from "../src/index.ts"

const officialFixture = fileURLToPath(new URL("./fixtures/official-playwright/.mcp.json", import.meta.url))
const dirs: string[] = []
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "official-mcp-"))
  dirs.push(dir)
  const source = join(dir, "market", "playwright")
  await mkdir(source, { recursive: true })
  return { source, market: join(dir, "market"), root: join(dir, "installed") }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("official MCP dialect compatibility", () => {
  // Removing direct-map normalization must break the actual public install,
  // before rekey/read/runtime consumers can observe the declared server.
  it.each(["direct", "wrapped"])("%s Playwright installs, rekeys and reaches async/sync/runtime consumers", async (dialect) => {
    const { source, market, root } = await workspace()
    const officialBytes = await readFile(officialFixture)
    const text = dialect === "direct" ? officialBytes.toString("utf8") : JSON.stringify({ mcpServers: JSON.parse(officialBytes.toString("utf8")) })
    await writeFile(join(source, ".mcp.json"), text)
    await mkdir(join(market, ".claude-plugin"))
    await writeFile(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "claude-plugins-official", plugins: [{ name: "playwright", source: "./playwright" }],
    }))
    const registry = new PluginRegistry({ root })
    await registry.addSource(market)
    await registry.install("claude-plugins-official__playwright")
    const installed = join(root, "claude-plugins-official__playwright")
    const expected = { "plugin:claude-plugins-_7a53a632223d:playwright": { command: "npx", args: ["@playwright/mcp@latest"] } }
    const asyncConfig = await readMcpServers(installed)
    expect(asyncConfig).toEqual(expected)
    expect(readMcpServersSync(installed)).toEqual(expected)
    await registry.enable("claude-plugins-official__playwright")
    expect(new PluginRegistry({ root }).runtimeInputs().mcpServerConfigs).toEqual(expected)
    expect(await readMcpServers(source)).toEqual({ playwright: { command: "npx", args: ["@playwright/mcp@latest"] } })
    expect(readMcpServersSync(source)).toEqual(await readMcpServers(source))
    expect(await readFile(join(source, ".mcp.json"), "utf8")).toBe(text)
    expect(await readFile(officialFixture)).toEqual(officialBytes)
  })

  it.each(["direct", "wrapped"])("%s preserves exact fields, skips SSE and bounds names for real consumer validation", async (dialect) => {
    const { source, root } = await workspace()
    const servers = {
      echo: { type: "stdio", command: "never-executed", args: ["one"], cwd: "./work", env: { TOKEN: "synthetic" }, ignored: 1 },
      http: { type: "streamable-http", url: "https://example.invalid/mcp", headers: { Authorization: "synthetic" } },
      sse: { type: "sse", url: "https://example.invalid/sse" },
      ["long".repeat(30)]: { command: "never-executed" },
    }
    const text = JSON.stringify(dialect === "direct" ? servers : { mcpServers: servers, ignored: "preserve wrapper extra-field behavior" })
    await writeFile(join(source, ".mcp.json"), text)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const installed = await installPlugin(source, "m", "p", root)
    const configs = await readMcpServers(installed.installPath)
    expect(configs["plugin:m__p:echo"]).toEqual({ command: "never-executed", args: ["one"], cwd: "./work", env: { TOKEN: "synthetic" } })
    expect(configs["plugin:m__p:http"]).toEqual({ url: "https://example.invalid/mcp", headers: { Authorization: "synthetic" } })
    expect(configs).not.toHaveProperty("plugin:m__p:sse")
    expect(Object.keys(configs)).toHaveLength(3)
    expect(warn.mock.calls.some(([message]) => String(message).includes("unsupported type \"sse\""))).toBe(true)
    for (const [serverName, config] of Object.entries(configs)) {
      expect(serverName.length).toBeLessThanOrEqual(64)
      assertServerName(serverName)
      validateMcpConfig(config.url ? { ...config, serverName, transport: "streamable-http", url: config.url } : { ...config, serverName, transport: "stdio", command: config.command!, args: config.args ?? [] })
    }
    expect(readMcpServersSync(installed.installPath)).toEqual(configs)
    expect(await readFile(join(source, ".mcp.json"), "utf8")).toBe(text)
  })

  it("an own wrapper takes precedence without merging direct siblings", async () => {
    const { source, root } = await workspace()
    await writeFile(join(source, ".mcp.json"), JSON.stringify({ mcpServers: { kept: { command: "kept" } }, ignored: { args: 42 } }))
    const installed = await installPlugin(source, "m", "p", root)
    expect(await readMcpServers(installed.installPath)).toEqual({ "plugin:m__p:kept": { command: "kept" } })
  })

  const malformed = [
    null, [], [ { command: "x" } ], 42,
    ...[null, [], 42, "bad"].map((mcpServers) => ({ mcpServers, validSibling: { command: "x" } })),
    // The literal direct server name mcpServers is reserved as a wrapper.
    { mcpServers: { command: "x", args: [] } },
    ...[null, [], 42].flatMap((entry) => [{ bad: entry }, { mcpServers: { bad: entry } }]),
    ...[{ command: 42 }, { cwd: [] }, { url: false }, { args: "x" }, { args: [42] }, { env: [] }, { env: { X: 42 } }, { headers: [] }, { headers: { X: false } }, { type: 42 }]
      .flatMap((entry) => [{ bad: entry }, { mcpServers: { bad: entry } }]),
  ]
  it.each(malformed.map((config, index) => ({ config, index })))("invalid replacement $index keeps old install and removes candidate", async ({ config }) => {
    const { source, root } = await workspace()
    await writeFile(join(source, ".mcp.json"), JSON.stringify({ mcpServers: { old: { command: "old" } } }))
    const installed = await installPlugin(source, "m", "p", root)
    const oldBytes = await readFile(join(installed.installPath, ".mcp.json"))
    const invalidText = JSON.stringify(config)
    await writeFile(join(source, ".mcp.json"), invalidText)
    await expect(installPlugin(source, "m", "p", root)).rejects.toMatchObject({ code: "plugin-invalid" })
    await expect(readMcpServers(source)).rejects.toMatchObject({ code: "plugin-invalid" })
    expect(() => readMcpServersSync(source)).toThrow()
    expect(await readFile(join(installed.installPath, ".mcp.json"))).toEqual(oldBytes)
    expect(readMcpServersSync(installed.installPath)).toEqual({ "plugin:m__p:old": { command: "old" } })
    expect(await readdir(root)).toEqual(["m__p"])
    expect(await readFile(join(source, ".mcp.json"), "utf8")).toBe(invalidText)
  })
})
