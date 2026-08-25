import { describe, expect, it } from "vitest"
import { syncTools } from "../src/index.ts"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { ConnectedMcpClient } from "../src/index.ts"

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
})
