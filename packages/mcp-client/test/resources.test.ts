import { describe, expect, it } from "vitest"
import { createResourceTools } from "../src/index.ts"
import type { ConnectedMcpClient } from "../src/index.ts"

function fakeClient(): ConnectedMcpClient {
  return {
    async listTools() { return { tools: [] } },
    async callTool() { return { content: [] } },
    async close() {},
  } as unknown as ConnectedMcpClient
}

describe("createResourceTools", () => {
  it("creates list_mcp_resources (optional server filter) and read_mcp_resource (server + uri)", () => {
    const client = fakeClient()
    const tools = createResourceTools(client, "files", { transport: "stdio", serverName: "files", command: "x", args: [] })
    const names = tools.map((t) => t.name)
    expect(names).toContain("list_mcp_resources")
    expect(names).toContain("read_mcp_resource")
  })

  it("read_mcp_resource calls resources/read with the uri", async () => {
    let called: { server: string; uri: string } | undefined
    const client: ConnectedMcpClient = {
      ...fakeClient(),
      async readResource(server: string, uri: string) { called = { server, uri }; return { text: "content" } },
    } as unknown as ConnectedMcpClient
    const tools = createResourceTools(client, "files", { transport: "stdio", serverName: "files", command: "x", args: [] })
    const readTool = tools.find((t) => t.name === "read_mcp_resource")!
    await readTool.execute({ server: "files", uri: "file:///a.txt" }, {} as never)
    expect(called).toEqual({ server: "files", uri: "file:///a.txt" })
  })
})
