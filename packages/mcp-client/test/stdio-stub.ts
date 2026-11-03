// A minimal MCP server stub (SDK Server + StdioServerTransport) exposing one
// tool named "echo", for tests that need a REAL stdio connect rather than a
// fake client. Extracted from client.test.ts, which uses it in four tests.
//
// Resolve the installed SDK (1.30.0, pnpm-symlinked under
// packages/mcp-client/node_modules) to absolute file URLs so the temp-dir fake
// server can import it. A bare "../../node_modules/..." would resolve to
// packages/node_modules (does not exist).
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpCallResult } from '../src/client.ts'

const SDK_SERVER_URL = new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href
const SDK_STDIO_URL = new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href
const SDK_TYPES_URL = new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js", import.meta.url).href

// 1.30.0 note: setRequestHandler requires real zod schemas (with a literal
// `method`), not plain objects — plain objects throw "Schema is missing a
// method literal".
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

// MCP-06: literal wire vectors deliberately bypass the SDK Server's narrower
// structuredContent record schema. The actual SDK Client/stdio transport and
// our normalized result schema still consume every response under test.
const LITERAL_SERVER = `
import { createInterface } from 'node:readline'
const callResult = /*CALL_RESULT*/null
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'literal-fixture', version: '1' } }
  else if (request.method === 'tools/call') result = callResult
  else if (request.method === 'tools/list') result = { tools: [] }
  else if (request.method === 'ping') result = {}
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'fixture method unavailable' } }) + '\\n'); return }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
})
`

/** Write the stub server script into a fresh temp dir and return its path. */
export function writeStdioStubServer(callResult?: McpCallResult & Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-stub-"))
  const script = join(dir, "fake-server.mjs")
  writeFileSync(script, callResult === undefined ? FAKE_SERVER : LITERAL_SERVER.replace('/*CALL_RESULT*/null', JSON.stringify(callResult)))
  return script
}
