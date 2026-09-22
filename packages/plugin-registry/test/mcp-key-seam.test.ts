/**
 * THE SEAM CONTRACT (D-MCP-1): every key `mcpServerKey` can compose must pass
 * BOTH mcp-client validators — `validateMcpConfig` (the one `mountMcpClient`
 * calls as its first statement) and `assertServerName` (the naming-side twin).
 *
 * Measured at HEAD before this test existed: the composer emitted
 * `plugin:<id>:<server>` (install.ts's documented grammar, colons included)
 * while both mcp-client validators accepted only `^[A-Za-z0-9_-]{1,32}$` — so
 * EVERY plugin MCP server, even the cleanest `plugin:hello:mcp`, was rejected
 * before a client ever started, and the assembly's per-server containment
 * downgraded all of it to one warn (100% dead in production).
 *
 * This test lives on the plugin-registry side on purpose: the composer is the
 * producer, the validators are the consumers, and the contract is that the
 * producer can never emit something the consumers refuse.
 */
import { describe, expect, it } from "vitest"
import { assertServerName, validateMcpConfig, type McpServerConfig } from "@i-harness/mcp-client"
import { mcpServerKey, mcpServerKeyPrefix, pluginId } from "../src/install.ts"

const stdio = (serverName: string): McpServerConfig => ({
  transport: "stdio",
  serverName,
  command: "x",
  args: [],
})

/** (id, server, why) — the three required cases plus the grammar's punctuation. */
const CASES: Array<[id: string, server: string, why: string]> = [
  ["Marketplace A__proxy", "echo", "realistic marketplace display name (space) + plain server"],
  ["hello", "mcp", "the cleanest possible pair — this threw too"],
  [`${"m".repeat(80)}__proxy`, "s".repeat(80), "a LONG id+server pair (the 32-char cap was the second blade)"],
  ["mkt__p", "server.v1:west", "the documented grammar's punctuation (`.`, `:`) in the server part"],
]

describe("plugin MCP key seam: mcpServerKey → mcp-client validators", () => {
  for (const [id, server, why] of CASES) {
    it(`mcpServerKey(${JSON.stringify(id)}, ${JSON.stringify(server)}) validates — ${why}`, () => {
      const key = mcpServerKey(id, server)
      expect(() => validateMcpConfig(stdio(key))).not.toThrow()
      expect(() => assertServerName(key)).not.toThrow()
    })
  }

  it("the marketplace/plugin id from pluginId() is just as valid a source", () => {
    const id = pluginId("Marketplace A", "proxy")
    const key = mcpServerKey(id, "echo")
    expect(() => validateMcpConfig(stdio(key))).not.toThrow()
    expect(() => assertServerName(key)).not.toThrow()
  })

  it("the composed key never exceeds the mcp-client cap (64), however long the parts", () => {
    const key = mcpServerKey("x".repeat(200), "y".repeat(200))
    expect(key.length).toBeLessThanOrEqual(64)
    expect(() => validateMcpConfig(stdio(key))).not.toThrow()
    expect(() => assertServerName(key)).not.toThrow()
  })

  it("truncation is deterministic and keeps distinct identities distinct", () => {
    const shared = "a".repeat(70)
    expect(mcpServerKey(`${shared}__one`, "s")).toBe(mcpServerKey(`${shared}__one`, "s"))
    expect(mcpServerKey(`${shared}__one`, "s")).not.toBe(mcpServerKey(`${shared}__two`, "s"))
    expect(mcpServerKey("p", `${"s".repeat(70)}1`)).not.toBe(mcpServerKey("p", `${"s".repeat(70)}2`))
  })

  it("attribution stays derivable: every key starts with its plugin's prefix", () => {
    for (const [id, server] of CASES) {
      const key = mcpServerKey(id, server)
      const prefix = mcpServerKeyPrefix(id)
      expect(key.startsWith("plugin:")).toBe(true)
      expect(key.startsWith(prefix)).toBe(true)
      // ... and the remainder is the server part, non-empty (the structure is
      // parseable: plugin:<id>:<server> with both parts from the same helper).
      expect(key.slice(prefix.length).length).toBeGreaterThan(0)
    }
    // The property that matters is over the TRUNCATED parts too: one id can
    // never produce a key that attributes to another id.
    const long = "m".repeat(120)
    expect(mcpServerKey(`${long}__a`, "s").startsWith(mcpServerKeyPrefix(`${long}__b`))).toBe(false)
    expect(mcpServerKey(long, "s").startsWith(mcpServerKeyPrefix(long))).toBe(true)
  })

  it("hostile parts (unicode, spaces, path-hostile chars) still land inside the grammar", () => {
    const cases: Array<[string, string]> = [
      ["mkt/with\\hostile:chars", "a b\tc"],
      ["日本語 market", "сервер"],
      ["", "srv"],
      ["id", ""],
    ]
    for (const [id, server] of cases) {
      const key = mcpServerKey(id, server)
      expect(() => validateMcpConfig(stdio(key))).not.toThrow()
      expect(() => assertServerName(key)).not.toThrow()
      expect(key.length).toBeLessThanOrEqual(64)
    }
  })
})
