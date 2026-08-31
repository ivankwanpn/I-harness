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
