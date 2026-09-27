import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionService } from "@i-harness/session-executor"
import { createDesktopMcp } from "../src/mcp-settings.ts"
import { pluginExtensions } from "../src/plugin-mount.ts"
import { writeStdioStubServer } from "../../mcp-client/test/stdio-stub.ts"

it("enables and disables a direct MCP server on the same existing Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-direct-mcp-"))
  const mcp = createDesktopMcp(join(root, "mcp-servers.json"))
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", extensionsFor: async (id) => pluginExtensions({ skillDirs: [], hookConfigs: [], commandDescriptors: [], agentDescriptors: [], mcpServerConfigs: {} }, root, id, () => {}, await mcp.active()) })
  mcp.bindRefresh(() => service.refreshExtensions())
  try {
    const assembly = await service.assemblyFor("s")
    await mcp.mutate({ action: "save", revision: 0, config: { serverName: "direct", transport: "stdio", command: process.execPath, args: [writeStdioStubServer()] } })
    expect(assembly.pluginMcpResults.has("direct")).toBe(false)
    await mcp.mutate({ action: "enable", name: "direct" })
    expect(assembly.pluginMcpResults.get("direct")).toBe(true)
    await mcp.mutate({ action: "disable", name: "direct" })
    expect(assembly.pluginMcpResults.has("direct")).toBe(false)
    expect(await service.assemblyFor("s")).toBe(assembly)
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
