import { describe, expect, it } from "vitest"
import { createConnectedClient } from "../src/index.ts"
import { execPath } from "node:process"
import { writeStdioStubServer } from "./stdio-stub.ts"

describe("createConnectedClient", () => {
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
