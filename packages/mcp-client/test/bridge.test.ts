import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, resultExecution, resultPresentation } from "@i-harness/core-tools"
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
    async listResources() {
      return []
    },
    async readResource() {
      return []
    },
    async close() {},
  } as ConnectedMcpClient
}

describe("createMcpTool", () => {
  it.each([false, true])('keeps the full normalized value on actual registered execution without retention (failed=%s)', async failed => {
    const normalized = { content: [{ type: 'text', text: 'body' }], isError: failed, structuredContent: failed ? null : { error: 'data', values: [false, null] } }
    const registry = createToolRegistry(createContext())
    registry.register(createMcpTool(fakeClient(normalized), 'remote', 'raw', { name: 'raw' }, { transport: 'stdio', serverName: 'fixture', command: 'unused', args: [] }))
    const prepared = await registry.prepare({ name: 'remote', args: {} })
    const output = await registry.dispatch(prepared)
    expect(output).toEqual(normalized)
    expect((await registry.finalize(prepared, output)).output).toEqual(normalized)
    expect(resultExecution(prepared)).toEqual({ outcome: failed ? 'failed' : 'succeeded', dispatch: 'dispatched' })
    expect(resultPresentation(prepared)).toBe('mcp')
    expect(() => resultPresentation({ ...prepared })).toThrow()
  })

  it('keeps direct successful execution content-only compatibility', async () => {
    const content = [{ type: 'text', text: 'compatibility' }]
    const tool = createMcpTool(fakeClient({ content, isError: false }), 'remote', 'raw', { name: 'raw' }, { transport: 'stdio', serverName: 'fixture', command: 'unused', args: [] })
    expect(await tool.execute({}, {} as never)).toEqual(content)
  })
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

// spec §3.8, the writer's half: this file is the ONE place a remote server's
// schema becomes a Tool, so it is the one place the foreign marker can be set.
// Without it the registry's assertion rejects a server for speaking draft-07 —
// measured on a real SDK server, whose zod→draft-7 conversion emits `$schema`
// at the schema root (a key no literal in this repo contains).
describe("createMcpTool — a remote schema is FOREIGN", () => {
  it("registers through the real registry although the server's schema leaves IH's subset", () => {
    const client = fakeClient({ content: [] })
    const tool = createMcpTool(
      client,
      "mcp__schema__draft",
      "draft",
      {
        name: "draft",
        description: "draft-07",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { text: { type: "string", format: "date" } },
          required: ["text"],
        },
      },
      { transport: "stdio", serverName: "schema", command: "x", args: [] },
    )
    expect(tool.inputSchemaForeign).toBe(true)
    const registry = createToolRegistry(createContext())
    expect(() => registry.register(tool)).not.toThrow()
    expect(registry.get("mcp__schema__draft")).toBeDefined()
  })
})
