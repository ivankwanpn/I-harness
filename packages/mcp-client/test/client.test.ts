import { describe, expect, it } from "vitest"
import { createConnectedClient } from "../src/index.ts"
import { execPath } from "node:process"
import { writeStdioStubServer } from "./stdio-stub.ts"
import { PNG, JPEG } from '../../image-validation/test/fixtures.ts'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

describe("createConnectedClient", () => {
  it.each([false, true])('preserves ordered normalized blocks, explicit isError=%s and structured null/object over local stdio', async failed => {
    const normalized = { content: [
      { type: 'text', text: 'ordered text' },
      { type: 'image', mimeType: 'image/png', data: PNG },
      { type: 'audio', mimeType: 'audio/wav', data: 'QUJD' },
      { type: 'resource', resource: { uri: 'file:///fixture/a', mimeType: 'text/plain', text: 'resource text' } },
      { type: 'image', mimeType: 'image/jpeg', data: JPEG },
      { type: 'resource_link', uri: 'https://example.invalid/a', name: 'link' },
    ], isError: failed, structuredContent: failed ? { nested: { error: 'payload', isError: false, values: [null, false, 42] } } : null }
    const script = writeStdioStubServer({ ...normalized, rawProviderExtra: 'outside normalized contract' })
    const client = await createConnectedClient({ transport: 'stdio', serverName: 'fixture', command: execPath, args: [script] })
    try {
      expect(await client.callTool('fixture', {}, undefined)).toEqual(normalized)
    } finally { await client.close(); await rm(dirname(script), { recursive: true, force: true }) }
  })
  it("listTools returns the server's tools via tools/list", async () => {
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [writeStdioStubServer()] })
    const { tools, nextCursor } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(["echo"])
    expect(nextCursor).toBeUndefined()
    await client.close()
  })

  it("callTool forwards tools/call with the raw name and returns content", async () => {
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [writeStdioStubServer()] })
    const result = await client.callTool("echo", { text: "hello" }, undefined)
    expect(JSON.stringify(result.content)).toContain("ok:hello")
    await client.close()
  })

  it("listResources returns the server's resources via resources/list", async () => {
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [writeStdioStubServer()] })
    const resources = await client.listResources()
    expect(resources).toEqual([{ uri: "note://a", name: "a", description: "note a" }])
    await client.close()
  })

  it("readResource reads a resource via resources/read with the uri", async () => {
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [writeStdioStubServer()] })
    const result = await client.readResource("fake", "note://a")
    expect(result).toEqual([{ uri: "note://a", mimeType: "text/plain", text: "hello resource" }])
    await client.close()
  })
})
