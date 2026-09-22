import { describe, expect, it } from "vitest"
import { createResourceTools } from "../src/index.ts"
import type { ConnectedMcpClient } from "../src/index.ts"

function fakeClient(): ConnectedMcpClient {
  return {
    async listTools() { return { tools: [] } },
    async callTool() { return { content: [] } },
    async listResources() { return [] },
    async readResource() { return {} },
    async close() {},
  } as unknown as ConnectedMcpClient
}

describe("createResourceTools", () => {
  it("creates server-qualified list_mcp_resources__files and read_mcp_resource__files", () => {
    const client = fakeClient()
    const tools = createResourceTools(client, "files", { transport: "stdio", serverName: "files", command: "x", args: [] })
    const names = tools.map((t) => t.name)
    expect(names).toContain("list_mcp_resources__files")
    expect(names).toContain("read_mcp_resource__files")
  })

  it("list_mcp_resources lists with the server filter and forwards abortSignal", async () => {
    let called: { server: string; signal?: AbortSignal } | undefined
    const client: ConnectedMcpClient = {
      ...fakeClient(),
      async listResources(server: string, signal?: AbortSignal) { called = { server, signal }; return [] },
    } as unknown as ConnectedMcpClient
    const tools = createResourceTools(client, "files", { transport: "stdio", serverName: "files", command: "x", args: [] })
    const listTool = tools.find((t) => t.name === "list_mcp_resources__files")!
    const signal = new AbortController().signal
    await listTool.execute({}, { abortSignal: signal } as never)
    expect(called).toEqual({ server: "files", signal })
  })

  it("read_mcp_resource calls resources/read with the uri and forwards abortSignal", async () => {
    let called: { server: string; uri: string; signal?: AbortSignal } | undefined
    const client: ConnectedMcpClient = {
      ...fakeClient(),
      async readResource(server: string, uri: string, signal?: AbortSignal) { called = { server, uri, signal }; return { text: "content" } },
    } as unknown as ConnectedMcpClient
    const tools = createResourceTools(client, "files", { transport: "stdio", serverName: "files", command: "x", args: [] })
    const readTool = tools.find((t) => t.name === "read_mcp_resource__files")!
    const signal = new AbortController().signal
    await readTool.execute({ server: "files", uri: "file:///a.txt" }, { abortSignal: signal } as never)
    expect(called).toEqual({ server: "files", uri: "file:///a.txt", signal })
  })

  it("a colon-bearing server name (a plugin key) yields provider-valid tool names, never the raw one", () => {
    // A valid SERVER name is not a valid TOOL name: every backend's tool-name
    // grammar rejects `:`, and all three helpers register on every mount, so
    // the raw form would fail the whole request for exactly the plugin mounts
    // the seam fix enabled.
    const serverName = "plugin:Marketplace_A__proxy:echo"
    const tools = createResourceTools(fakeClient(), serverName, { transport: "stdio", serverName, command: "x", args: [] })
    const names = tools.map((t) => t.name)
    expect(names).toHaveLength(3)
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(name).not.toContain(":")
    }
    // The raw, colon-bearing form is not among them.
    expect(names).not.toContain(`list_mcp_resources__${serverName}`)
    expect(names).not.toContain(`read_mcp_resource__${serverName}`)
    expect(names).not.toContain(`list_mcp_resource_templates__${serverName}`)
  })

  it("list_mcp_resource_templates__files exists and forwards to client.listResourceTemplates", async () => {
    let called: { signal?: AbortSignal } | undefined
    const client: ConnectedMcpClient = {
      ...fakeClient(),
      async listResourceTemplates(signal?: AbortSignal) { called = { signal }; return [{ uriTemplate: "data://{id}", name: "x" }] },
    } as unknown as ConnectedMcpClient
    const tools = createResourceTools(client, "files", { transport: "stdio", serverName: "files", command: "x", args: [] })
    const templatesTool = tools.find((t) => t.name === "list_mcp_resource_templates__files")!
    const signal = new AbortController().signal
    const out = await templatesTool.execute({}, { abortSignal: signal } as never)
    expect(called).toEqual({ signal })
    expect(out).toEqual([{ uriTemplate: "data://{id}", name: "x" }])
  })
})
