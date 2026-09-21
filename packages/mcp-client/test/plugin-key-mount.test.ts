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
import { fitPublicName } from "../src/naming.ts"
import { mountMcpClient, publicToolName } from "../src/index.ts"
import { writeStdioStubServer } from "./stdio-stub.ts"

/** The three resource helper prefixes (resources.ts). */
const RESOURCE_PREFIXES = ["list_mcp_resources__", "list_mcp_resource_templates__", "read_mcp_resource__"] as const

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
      // THE REVIEW-CAUGHT HALF: a valid SERVER name is not a valid TOOL name.
      // Every plugin key carries colons, and all three resource helpers
      // register unconditionally on every mount — so each must land inside the
      // provider grammar, and the raw colon-bearing name must NOT exist.
      for (const prefix of RESOURCE_PREFIXES) {
        const name = fitPublicName(`${prefix}${serverName}`)
        expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
        expect(tools.get(name)).toBeDefined()
        expect(tools.get(`${prefix}${serverName}`)).toBeUndefined()
      }
      // An independent pin, not a mirror of the helper: for the read helper the
      // sanitized candidate fits untruncated (19 + 32 = 51), so the exact shape
      // is fully determined — prefix, sanitized key, 12-hex suffix — and the
      // REGISTRY really carries it, not just the helper's return value.
      const readName = fitPublicName(`read_mcp_resource__${serverName}`)
      expect(readName).toMatch(/^read_mcp_resource__plugin_Marketplace_A__proxy_echo_[0-9a-f]{12}$/)
      expect(tools.get(readName)).toBeDefined()
      // …and the simple-name contract still holds byte-for-byte (every test
      // that predates the plugin seam uses names like these).
      expect(fitPublicName("list_mcp_resources__files")).toBe("list_mcp_resources__files")
      // Attribution: the mounted name is under its plugin's prefix.
      expect(serverName.startsWith(mcpServerKeyPrefix(id))).toBe(true)
    } finally {
      await handle.unmount()
    }
    expect(tools.get(publicToolName(serverName, "echo"))).toBeUndefined()
    for (const prefix of RESOURCE_PREFIXES) {
      expect(tools.get(fitPublicName(`${prefix}${serverName}`))).toBeUndefined()
    }
  })
})
