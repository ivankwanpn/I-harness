import { describe, expect, it, vi } from "vitest"
import { syncTools, type McpServerConfig } from "../src/index.ts"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { ConnectedMcpClient } from "../src/index.ts"

function blockedDirectClient(tools: Array<{ name: string }>) {
  return {
    async listTools() { return { tools } },
    async callTool() { return { content: [] } },
    async listResources() { return [] },
    async readResource() { return [] },
    async close() {},
  } as unknown as ConnectedMcpClient
}

describe("blocked/direct policy", () => {
  function clientWith(tools: Array<{ name: string }>) {
    return blockedDirectClient(tools)
  }
  function cfg(extra: object) {
    return { transport: "stdio", serverName: "files", command: "x", args: [], ...extra } as McpServerConfig
  }

  it("blocked tools are never registered; others still are", async () => {
    const reg = registry()
    const disposers = await syncTools(
      clientWith([{ name: "safe" }, { name: "nuke" }]),
      reg,
      cfg({ blockedTools: ["nuke"] }),
    )
    const names = reg.schemas().map((s) => s.name)
    expect(names).toContain("mcp__files__safe")
    expect(names).not.toContain("mcp__files__nuke")
    // 每個 registered 工具都有對應 disposer
    expect([...disposers.keys()]).toContain("mcp__files__safe")
    expect([...disposers.keys()]).not.toContain("mcp__files__nuke")
  })

  it("blocked wins over direct (a tool in both lists stays unregistered)", async () => {
    const reg = registry()
    await syncTools(clientWith([{ name: "nuke" }]), reg, cfg({ blockedTools: ["nuke"], directTools: ["nuke"] }))
    expect(reg.schemas().map((s) => s.name)).not.toContain("mcp__files__nuke")
  })

  it("directTools narrows exposure: listed tools direct, everything else deferred", async () => {
    const reg = registry()
    const disposers = await syncTools(
      clientWith([{ name: "hot" }, { name: "cold" }]),
      reg,
      cfg({ directTools: ["hot"] }),
    )
    // exposure 直接落在 Tool 物件（createMcpTool 5th 參數）；schemas 表面由真 registry 過濾——
    // 此處用 registry stub 的 get 斷言即可（sync.test 慣例：stub schemas 不複製 exposure 過濾）
    expect(reg.get("mcp__files__hot")).toMatchObject({ exposure: "direct" })
    expect(reg.get("mcp__files__cold")).toMatchObject({ exposure: "deferred" })
    expect([...disposers.keys()]).toEqual(expect.arrayContaining(["mcp__files__hot", "mcp__files__cold"]))
  })

  it("absent directTools keeps today's behavior: everything direct", async () => {
    const reg = registry()
    await syncTools(clientWith([{ name: "any" }]), reg, cfg({}))
    expect(reg.get("mcp__files__any")).toMatchObject({ exposure: "direct" })
  })
})

function registry(): ToolRegistry {
  const tools: Tool[] = []
  return {
    register(t: Tool) {
      tools.push(t)
    },
    get(name: string) {
      return tools.find((t) => t.name === name)
    },
    schemas() {
      return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    },
    unregister(name: string) {
      const i = tools.findIndex((t) => t.name === name)
      if (i >= 0) tools.splice(i, 1)
    },
  } as unknown as ToolRegistry
}

// Like the real ToolRegistry: registering an already-present name throws. The
// shared registry() stub above never throws, so conflict tests need this one.
function throwingRegistry(): { store: Map<string, Tool>; tools: ToolRegistry } {
  const store = new Map<string, Tool>()
  const tools = {
    register(t: Tool) {
      if (store.has(t.name)) throw new Error(`duplicate tool registration: ${t.name}`)
      store.set(t.name, t)
    },
    get(name: string) {
      return store.get(name)
    },
    schemas() {
      return [...store.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    },
    unregister(name: string) {
      store.delete(name)
    },
  } as unknown as ToolRegistry
  return { store, tools }
}

describe("syncTools", () => {
  it("registers server tools under public names and returns disposers", async () => {
    const tools = registry()
    const client: ConnectedMcpClient = {
      async listTools() {
        return {
          tools: [
            { name: "read_file", description: "read", inputSchema: {} },
            { name: "write_file", description: "write", inputSchema: {} },
          ],
        }
      },
      async callTool() {
        return { content: [] }
      },
      async listResources() {
        return []
      },
      async readResource() {
        return []
      },
      async close() {},
    }
    const disposers = await syncTools(client, tools, { transport: "stdio", serverName: "files", command: "x", args: [] })
    expect(tools.get("mcp__files__read_file")).toBeDefined()
    expect(tools.get("mcp__files__write_file")).toBeDefined()
    expect(disposers.size).toBe(2)
    // dispose unregisters
    for (const d of disposers.values()) d()
    expect(tools.get("mcp__files__read_file")).toBeUndefined()
  })

  it("throws on duplicate raw names in the server list (fetch phase)", async () => {
    const tools = registry()
    const client: ConnectedMcpClient = {
      async listTools() {
        return {
          tools: [
            { name: "dupe", description: "a" },
            { name: "dupe", description: "b" },
          ],
        }
      },
      async callTool() {
        return { content: [] }
      },
      async listResources() {
        return []
      },
      async readResource() {
        return []
      },
      async close() {},
    }
    await expect(syncTools(client, tools, { transport: "stdio", serverName: "s", command: "x", args: [] })).rejects.toThrow(/more than once/)
  })

  it("drains the cursor across pages before registering anything", async () => {
    const tools = registry()
    const seen: Array<string | undefined> = []
    const client: ConnectedMcpClient = {
      async listTools(cursor) {
        seen.push(cursor)
        if (cursor === undefined) {
          return { tools: [{ name: "a", description: "a", inputSchema: {} }], nextCursor: "p2" }
        }
        return { tools: [{ name: "b", description: "b", inputSchema: {} }] }
      },
      async callTool() {
        return { content: [] }
      },
      async listResources() {
        return []
      },
      async readResource() {
        return []
      },
      async close() {},
    }
    const disposers = await syncTools(client, tools, { transport: "stdio", serverName: "files", command: "x", args: [] })
    expect(seen).toEqual([undefined, "p2"])
    expect(tools.get("mcp__files__a")).toBeDefined()
    expect(tools.get("mcp__files__b")).toBeDefined()
    expect(disposers.size).toBe(2)
  })

  it("rolls back to zero tools and logs a warning on a registry conflict (re-sync)", async () => {
    const { tools } = throwingRegistry()
    const client: ConnectedMcpClient = {
      async listTools() {
        return { tools: [{ name: "read_file", description: "read", inputSchema: {} }] }
      },
      async callTool() {
        return { content: [] }
      },
      async listResources() {
        return []
      },
      async readResource() {
        return []
      },
      async close() {},
    }
    // Sticky foreign squat: a tool with this server's public name is already
    // registered (by another mount), so register throws on the first (and
    // only) tool of this generation.
    const foreign: Tool = {
      name: "mcp__files__read_file",
      description: "foreign",
      inputSchema: {},
      async execute() {
        return []
      },
    }
    tools.register(foreign)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const disposers = await syncTools(client, tools, { transport: "stdio", serverName: "files", command: "x", args: [] }, new Map([["old-gen", () => {}]]))
      expect(disposers.size).toBe(0)
      expect(disposers).toEqual(new Map())
      expect(warnSpy).toHaveBeenCalled()
      // zero tools from this server registered — only the foreign one remains
      expect(tools.get("mcp__files__read_file")).toBeDefined()
      expect(tools.schemas()).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("swaps generations: previous disposers called and new generation registered", async () => {
    const tools = registry()
    const client: ConnectedMcpClient = {
      async listTools() {
        return {
          tools: [
            { name: "read_file", description: "gen1", inputSchema: {} },
            { name: "write_file", description: "gen2", inputSchema: {} },
          ],
        }
      },
      async callTool() {
        return { content: [] }
      },
      async listResources() {
        return []
      },
      async readResource() {
        return []
      },
      async close() {},
    }
    const config: McpServerConfig = { transport: "stdio", serverName: "files", command: "x", args: [] }
    // Gen 1
    const disposers1 = await syncTools(client, tools, config)
    expect(tools.get("mcp__files__read_file")).toBeDefined()
    expect(tools.get("mcp__files__write_file")).toBeDefined()
    expect(disposers1.size).toBe(2)
    // Gen 2, populated previous map
    const disposers2 = await syncTools(client, tools, config, disposers1)
    expect(disposers2.size).toBe(2)
    expect(tools.get("mcp__files__read_file")).toBeDefined()
    expect(tools.get("mcp__files__write_file")).toBeDefined()
    // still exactly one generation registered (old tools gone — schemas count
    // equals the new generation, not two generations stacked)
    expect(tools.schemas()).toHaveLength(2)
  })

  it("propagates the registry conflict on the initial sync (no previous generation)", async () => {
    const { tools } = throwingRegistry()
    const client: ConnectedMcpClient = {
      async listTools() {
        return { tools: [{ name: "read_file", description: "read", inputSchema: {} }] }
      },
      async callTool() {
        return { content: [] }
      },
      async listResources() {
        return []
      },
      async readResource() {
        return []
      },
      async close() {},
    }
    // Sticky foreign squat before the first sync of this server.
    tools.register({
      name: "mcp__files__read_file",
      description: "foreign",
      inputSchema: {},
      async execute() {
        return []
      },
    })
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      // Initial sync: the conflict must reject (spec §3.4, fail-closed) — not
      // silently return an empty map. The foreign tool stays untouched.
      await expect(syncTools(client, tools, { transport: "stdio", serverName: "files", command: "x", args: [] })).rejects.toThrow(/duplicate tool registration/)
      expect(tools.get("mcp__files__read_file")).toBeDefined() // foreign tool kept
      // rollback happened: no duplicate of this server's tool is registered
      expect(tools.schemas()).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
