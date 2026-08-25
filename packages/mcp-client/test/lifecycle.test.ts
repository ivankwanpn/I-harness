import { describe, expect, it } from "vitest"
import { mountMcpClient, type McpMountHandle } from "../src/index.ts"
import { createToolRegistry } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"
import type { McpServerConfig, ConnectedMcpClient } from "../src/index.ts"

// Inject a fake client via a test-only factory (see the implementation below).
async function mountWithFake(tools: ReturnType<typeof createToolRegistry>, config: McpServerConfig, fake: ConnectedMcpClient): Promise<McpMountHandle> {
  return mountMcpClient({} as never, tools, config, { connect: async () => fake })
}

describe("mountMcpClient lifecycle", () => {
  it("mount registers MCP tools; unmount unregisters + closes", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = { transport: "stdio", serverName: "files", command: "x", args: [] }
    let closed = false
    const fake: ConnectedMcpClient = {
      async listTools() { return { tools: [{ name: "read_file", description: "read", inputSchema: {} }] } },
      async callTool() { return { content: [] } },
      async listResources() { return [] },
      async readResource() { return {} },
      async close() { closed = true },
    }
    const handle = await mountWithFake(tools, config, fake)
    expect(tools.get("mcp__files__read_file")).toBeDefined()
    expect(tools.get("list_mcp_resources__files")).toBeDefined()
    expect(tools.get("read_mcp_resource__files")).toBeDefined()
    await handle.unmount()
    expect(tools.get("mcp__files__read_file")).toBeUndefined()
    expect(tools.get("list_mcp_resources__files")).toBeUndefined()
    expect(tools.get("read_mcp_resource__files")).toBeUndefined()
    expect(closed).toBe(true)
  })

  it("throws on duplicate live serverName", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = { transport: "stdio", serverName: "dupe", command: "x", args: [] }
    const fake: ConnectedMcpClient = {
      async listTools() { return { tools: [] } },
      async close() {},
    } as unknown as ConnectedMcpClient
    await mountWithFake(tools, config, fake)
    await expect(mountWithFake(tools, config, fake)).rejects.toThrow(/serverName.*reserved|duplicate/)
  })

  it("unmount releases the reservation so the serverName can be mounted again", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = { transport: "stdio", serverName: "recycle", command: "x", args: [] }
    const fake: ConnectedMcpClient = {
      async listTools() { return { tools: [] } },
      async close() {},
    } as unknown as ConnectedMcpClient
    const first = await mountWithFake(tools, config, fake)
    await first.unmount()
    const second = await mountWithFake(tools, config, fake)
    await expect(second.unmount()).resolves.toBeUndefined()
  })

  it("startup failure throws by default and releases the reservation", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = { transport: "stdio", serverName: "boom", command: "x", args: [] }
    const failing = { connect: async () => { throw new Error("connect refused") } }
    await expect(mountMcpClient({} as never, tools, config, failing)).rejects.toThrow(/connect refused/)
    // The failed mount must not leave the name reserved — a retry succeeds.
    const fake: ConnectedMcpClient = {
      async listTools() { return { tools: [] } },
      async close() {},
    } as unknown as ConnectedMcpClient
    await expect(mountWithFake(tools, config, fake)).resolves.toBeDefined()
  })

  it("failOnStartupError=false mounts empty (no tools, reservation released)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = { transport: "stdio", serverName: "soft", command: "x", args: [], failOnStartupError: false }
    let warn = ""
    const original = console.warn
    console.warn = (m: string) => { warn += m }
    try {
      const failing = { connect: async () => { throw new Error("connect refused") } }
      const handle = await mountMcpClient({} as never, tools, config, failing)
      expect(handle.serverName).toBe("soft")
      // empty mount: nothing registered, nothing is left behind
      expect(warn).toContain("failOnStartupError=false")
      await handle.unmount()
    } finally {
      console.warn = original
    }
    const fake: ConnectedMcpClient = {
      async listTools() { return { tools: [] } },
      async close() {},
    } as unknown as ConnectedMcpClient
    await expect(mountWithFake(tools, config, fake)).resolves.toBeDefined()
  })
})
