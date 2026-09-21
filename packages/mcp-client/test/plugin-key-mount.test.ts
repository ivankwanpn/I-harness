/**
 * The MOUNT half of the D-MCP-1 red line. The seam test lives on the
 * plugin-registry side and proves every composed key VALIDATES; this one proves
 * one actually MOUNTS: a real stdio client (the shared SDK stub), the whole
 * `mountMcpClient` path (validate → reserve → supervisor → tool sync), with the
 * server name produced by the SAME `mcpServerKey` the install path re-keys with.
 *
 * Before the fix, `mountMcpClient`'s first statement rejected this name, so the
 * only production MCP mount path (plugin `.mcp.json` → assembly) never mounted
 * a single server — this is the smallest test that would have caught it.
 */
import { describe, expect, it } from "vitest"
import { execPath } from "node:process"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
// `mcpServerKey` is deliberately NOT a package export of @i-harness/plugin-registry
// (an export with only test consumers is a NEW reachability-gate row), so the
// test reaches the source file directly — the seam under test is the composer,
// not the package boundary.
import { mcpServerKey, mcpServerKeyPrefix, pluginId } from "../../plugin-registry/src/install.ts"
import { mountMcpClient, publicToolName } from "../src/index.ts"
import { writeStdioStubServer } from "./stdio-stub.ts"

describe("plugin MCP mount seam (D-MCP-1)", () => {
  it("mounts a server whose name came from mcpServerKey, then unmounts it", async () => {
    const id = pluginId("Marketplace A", "proxy")
    const serverName = mcpServerKey(id, "echo")
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const handle = await mountMcpClient({} as never, tools, {
      transport: "stdio",
      serverName,
      command: execPath,
      args: [writeStdioStubServer()],
    })
    try {
      expect(handle.serverName).toBe(serverName)
      // The stub lists one tool named "echo"; the registry name is the public
      // (sanitized + hashed, since the key carries `:` and `__`) form.
      const publicName = publicToolName(serverName, "echo")
      expect(tools.get(publicName)).toBeDefined()
      // Resource helpers are server-qualified by the RAW key.
      expect(tools.get(`list_mcp_resources__${serverName}`)).toBeDefined()
      // Attribution: the mounted name is under its plugin's prefix.
      expect(serverName.startsWith(mcpServerKeyPrefix(id))).toBe(true)
    } finally {
      await handle.unmount()
    }
    expect(tools.get(publicToolName(serverName, "echo"))).toBeUndefined()
    expect(tools.get(`list_mcp_resources__${serverName}`)).toBeUndefined()
  })
})
