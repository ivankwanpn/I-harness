import { describe, expect, it, vi } from "vitest"
import {
  MAX_CURSOR_LENGTH,
  MAX_TOOL_ITEMS,
  McpCatalogError,
  syncTools,
  validateMcpConfig,
  type McpServerConfig,
} from "../src/index.ts"
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

// A fake server whose every page costs `delayMs` of wall clock and whose walk
// is `pages` long. The drain-deadline tests need a walk that is slow AS A
// WHOLE while each single page stays far under any per-page default. Records
// the RequestOptions the drain handed it per page (undefined = none passed).
function pagingClient(pages: number, delayMs: number): {
  client: ConnectedMcpClient
  calls: Array<{ cursor: string | undefined; opts: { timeout?: number; maxTotalTimeout?: number } | undefined }>
} {
  const calls: Array<{ cursor: string | undefined; opts: { timeout?: number; maxTotalTimeout?: number } | undefined }> = []
  let served = 0
  const client = {
    async listTools(cursor?: string, opts?: { timeout?: number; maxTotalTimeout?: number }) {
      calls.push({ cursor, opts })
      const index = served
      served += 1
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return {
        tools: [{ name: `t${index}`, description: "x", inputSchema: {} }],
        ...(index < pages - 1 ? { nextCursor: `c${index}` } : {}),
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
  } as unknown as ConnectedMcpClient
  return { client, calls }
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

  // M6-D1: the drain's remaining bounds. A catalogue is server-controlled, so
  // each of these is a way a broken/hostile server could spend unbounded work.
  it("rejects a server that repeats a cursor instead of walking forever", async () => {
    const tools = registry()
    const client: ConnectedMcpClient = {
      async listTools() {
        return { tools: [], nextCursor: "same" } // 永遠同一個
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
    await expect(syncTools(client, tools, { transport: "stdio", serverName: "files", command: "x", args: [] })).rejects.toMatchObject({
      reason: "repeated-cursor",
    })
  })

  it("rejects a catalogue larger than the defensive item cap — blocked tools still count (they were listed)", async () => {
    const tools = registry()
    let page = 0
    const client: ConnectedMcpClient = {
      async listTools() {
        const start = page * 100
        page += 1
        // Page 2 is the LAST page: the cap must end the drain on its own, not
        // the cursor running out.
        return {
          tools: Array.from({ length: 100 }, (_, i) => ({ name: `t${start + i}`, description: "x", inputSchema: {} })),
          ...(page < 2 ? { nextCursor: `c${page}` } : {}),
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
    // Every tool of page 1 is blocked. An implementation that counted only the
    // tools it REGISTERED would stay under the cap (100 < 150) and the drain
    // would complete; the cap is on what the server LISTED (200 > 150).
    const blockedTools = Array.from({ length: 100 }, (_, i) => `t${i}`)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(
        syncTools(client, tools, { transport: "stdio", serverName: "files", command: "x", args: [], catalogMaxItems: 150, blockedTools }),
      ).rejects.toMatchObject({ reason: "items-cap" })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("rejects an absurdly long cursor (typed, with the code discriminant)", async () => {
    const tools = registry()
    const client: ConnectedMcpClient = {
      async listTools() {
        return { tools: [], nextCursor: "x".repeat(MAX_CURSOR_LENGTH + 1) }
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
    const err = await syncTools(client, tools, { transport: "stdio", serverName: "files", command: "x", args: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpCatalogError)
    expect(err).toMatchObject({ code: "mcp_catalog", reason: "cursor-cap" })
  })

  it("still ends a never-terminating drain at 100 pages — the extracted page cap kept its value and message", async () => {
    const tools = registry()
    let page = 0
    const client: ConnectedMcpClient = {
      async listTools() {
        page += 1
        return { tools: [], nextCursor: `c${page}` } // a FRESH cursor each page: not the repeated-cursor case
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
    await expect(syncTools(client, tools, { transport: "stdio", serverName: "files", command: "x", args: [] })).rejects.toThrow(
      /pagination exceeded 100 pages/,
    )
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

// M6-D2: the drain's overall deadline. The caps above bound the WORK a server
// can extract; this bounds the TIME it can spend doing so — a server whose
// every page is merely slow must fail inside ONE budget, not pay a per-page
// timeout per page (spec §4.3: 逐頁都慢 ⇒ 整體界內失敗).
describe("the catalogue drain's overall deadline", () => {
  const cfg = (extra: object): McpServerConfig =>
    ({ transport: "stdio", serverName: "files", command: "x", args: [], ...extra }) as McpServerConfig

  it("rejects with the typed timeout reason when the pages outlast catalogTimeoutMs", async () => {
    const tools = registry()
    // 10 pages x 30ms ≈ 300ms of walk; the budget is 50ms.
    const { client, calls } = pagingClient(10, 30)
    const err = await syncTools(client, tools, cfg({ catalogTimeoutMs: 50 })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(McpCatalogError)
    expect(err).toMatchObject({ code: "mcp_catalog", reason: "timeout" })
    expect((err as Error).message).toContain("mcp-client(files):")
    // It stopped MID-walk, and every page it did request carried the REMAINING
    // total as its own bound — not the 60s tool-call default.
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.length).toBeLessThan(10)
    for (const call of calls) {
      expect(call.opts?.maxTotalTimeout).toBeGreaterThan(0)
      expect(call.opts?.maxTotalTimeout).toBeLessThanOrEqual(50)
      // toolCallTimeoutMs is unset here, so the per-page timeout IS the
      // remaining total: min(remaining, 60_000) = remaining.
      expect(call.opts?.timeout).toBe(call.opts?.maxTotalTimeout)
    }
    expect(tools.schemas()).toHaveLength(0) // fetch phase: nothing registered
  })

  it("completes the same slow drain when the budget leaves room — the bound is not 'always throws'", async () => {
    const tools = registry()
    const { client, calls } = pagingClient(10, 30)
    const disposers = await syncTools(client, tools, cfg({ catalogTimeoutMs: 1_000 }))
    expect(calls).toHaveLength(10)
    expect(disposers.size).toBe(10)
    expect(tools.schemas()).toHaveLength(10)
    // the pages really were handed a deadline derived from the 1000ms budget
    expect(calls[0]?.opts?.maxTotalTimeout).toBeLessThanOrEqual(1_000)
    expect(calls[0]?.opts?.maxTotalTimeout).toBeGreaterThan(0)
  })

  it("bounds each page by min(remaining total, toolCallTimeoutMs)", async () => {
    const tools = registry()
    const { client, calls } = pagingClient(10, 0)
    await syncTools(client, tools, cfg({ catalogTimeoutMs: 1_000, toolCallTimeoutMs: 5 }))
    expect(calls).toHaveLength(10)
    for (const call of calls) {
      expect(call.opts?.timeout).toBe(5) // the smaller of the two
      expect(call.opts?.maxTotalTimeout).toBeGreaterThan(5) // the total still rules
      expect(call.opts?.maxTotalTimeout).toBeLessThanOrEqual(1_000)
    }
  })
})

describe("the catalogue caps are DEFENSIVE bounds", () => {
  it("a realistic catalogue (the stdio stub's 1 tool; a synthetic 100) stays far below MAX_TOOL_ITEMS", () => {
    // test/stdio-stub.ts exposes exactly one tool ("echo"), and a 100-tool
    // server is already a large synthetic catalogue. The bound exists so a
    // broken or hostile paginator cannot spend unbounded work — it is not a
    // policy number, and it must not creep down toward real catalogues.
    expect(MAX_TOOL_ITEMS).toBe(10_000)
    expect(100).toBeLessThan(MAX_TOOL_ITEMS / 10) // a 100-tool catalogue is <1% of the cap
  })
})

describe("catalogMaxItems config validation", () => {
  const cfg = (catalogMaxItems: number): McpServerConfig => ({
    transport: "stdio",
    serverName: "files",
    command: "x",
    args: [],
    catalogMaxItems,
  })

  it("accepts a positive integer", () => {
    expect(() => validateMcpConfig(cfg(250))).not.toThrow()
  })

  it("rejects a non-positive or non-integer value (the toolCallTimeoutMs house rule)", () => {
    expect(() => validateMcpConfig(cfg(0))).toThrow(/catalogMaxItems/)
    expect(() => validateMcpConfig(cfg(-1))).toThrow(/catalogMaxItems/)
    expect(() => validateMcpConfig(cfg(1.5))).toThrow(/catalogMaxItems/)
  })
})

describe("catalogTimeoutMs config validation", () => {
  const cfg = (catalogTimeoutMs: number): McpServerConfig => ({
    transport: "stdio",
    serverName: "files",
    command: "x",
    args: [],
    catalogTimeoutMs,
  })

  it("accepts a positive integer", () => {
    expect(() => validateMcpConfig(cfg(30_000))).not.toThrow()
  })

  it("rejects a non-positive or non-integer value (the same house rule)", () => {
    expect(() => validateMcpConfig(cfg(0))).toThrow(/catalogTimeoutMs/)
    expect(() => validateMcpConfig(cfg(-1))).toThrow(/catalogTimeoutMs/)
    expect(() => validateMcpConfig(cfg(1.5))).toThrow(/catalogTimeoutMs/)
  })
})
