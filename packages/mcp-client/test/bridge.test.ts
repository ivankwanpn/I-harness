import { describe, expect, it } from "vitest"
import { createMcpTool } from "../src/index.ts"
import type { ConnectedMcpClient } from "../src/index.ts"

function fakeClient(result: { content: unknown[]; isError?: boolean }): ConnectedMcpClient {
  return {
    async listTools() {
      return { tools: [] }
    },
    async callTool() {
      return result
    },
    async close() {},
  } as ConnectedMcpClient
}

describe("createMcpTool", () => {
  it("maps name/description/inputSchema and forwards calls by raw name", async () => {
    const client = fakeClient({ content: [], isError: false })
    let calledRaw = ""
    const c: ConnectedMcpClient = {
      ...client,
      async callTool(name) {
        calledRaw = name
        return { content: [] }
      },
    }
    const tool = createMcpTool(
      c,
      "mcp__files__read_file",
      "read_file",
      { name: "read_file", description: "read a file", inputSchema: { type: "object" } },
      { transport: "stdio", serverName: "files", command: "x", args: [] },
    )
    expect(tool.name).toBe("mcp__files__read_file")
    expect(tool.description).toBe("read a file")
    await tool.execute({}, {} as never)
    expect(calledRaw).toBe("read_file")
  })

  it("throws when the MCP server returns isError: true", async () => {
    const client = fakeClient({ content: [{ type: "text", text: "boom" }], isError: true })
    const tool = createMcpTool(client, "mcp__s__t", "t", { name: "t" }, { transport: "stdio", serverName: "s", command: "x", args: [] })
    await expect(tool.execute({}, {} as never)).rejects.toThrow(/tool error|boom/)
  })
})
