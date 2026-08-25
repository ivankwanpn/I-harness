import { describe, expect, it } from "vitest"
import { createConnectedClient } from "../src/index.ts"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execPath } from "node:process"

// Resolve the installed SDK (1.30.0, pnpm-symlinked under packages/mcp-client/node_modules)
// to absolute file URLs so the temp-dir fake server can import it. The brief's
// "../../node_modules/..." would resolve to packages/node_modules (does not exist).
const SDK_SERVER_URL = new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href
const SDK_STDIO_URL = new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href
const SDK_TYPES_URL = new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url).href

// A minimal MCP server (SDK Server + StdioServerTransport) exposing one tool.
// 1.30.0 note: setRequestHandler requires real zod schemas (with a literal
// `method`), not plain objects — plain objects throw "Schema is missing a method literal".
const FAKE_SERVER = `
import { Server } from ${JSON.stringify(SDK_SERVER_URL)}
import { StdioServerTransport } from ${JSON.stringify(SDK_STDIO_URL)}
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from ${JSON.stringify(SDK_TYPES_URL)}
const server = new Server({ name: "fake", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const p = req.params
  return { content: [{ type: "text", text: "ok:" + p.arguments?.text }] }
})
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "note://a", name: "a", description: "note a" }],
}))
server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents: [{ uri: req.params.uri, mimeType: "text/plain", text: "hello resource" }],
}))
await server.connect(new StdioServerTransport())
`

function writeFakeServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "m17-"))
  const script = join(dir, "fake-server.mjs")
  writeFileSync(script, FAKE_SERVER)
  return script
}

describe("createConnectedClient", () => {
  it("listTools returns the server's tools via tools/list", async () => {
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [writeFakeServer()] })
    const { tools, nextCursor } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(["echo"])
    expect(nextCursor).toBeUndefined()
    await client.close()
  })

  it("callTool forwards tools/call with the raw name and returns content", async () => {
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [writeFakeServer()] })
    const result = await client.callTool("echo", { text: "hello" }, undefined)
    expect(JSON.stringify(result.content)).toContain("ok:hello")
    await client.close()
  })

  it("listResources returns the server's resources via resources/list", async () => {
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [writeFakeServer()] })
    const resources = await client.listResources()
    expect(resources).toEqual([{ uri: "note://a", name: "a", description: "note a" }])
    await client.close()
  })

  it("readResource reads a resource via resources/read with the uri", async () => {
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [writeFakeServer()] })
    const result = await client.readResource("fake", "note://a")
    expect(result).toEqual([{ uri: "note://a", mimeType: "text/plain", text: "hello resource" }])
    await client.close()
  })
})
