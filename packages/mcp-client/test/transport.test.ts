import { describe, expect, it } from "vitest"
import { validateMcpConfig, type McpServerConfig } from "../src/index.ts"

describe("validateMcpConfig", () => {
  it("accepts a valid stdio config", () => {
    const cfg: McpServerConfig = { transport: "stdio", serverName: "files", command: "node", args: ["server.js"] }
    expect(() => validateMcpConfig(cfg)).not.toThrow()
  })

  it("accepts a valid streamable-http config", () => {
    const cfg: McpServerConfig = { transport: "streamable-http", serverName: "remote", url: "http://localhost:3000/mcp" }
    expect(() => validateMcpConfig(cfg)).not.toThrow()
  })

  it("accepts the plugin namespace form — `[A-Za-z0-9_.:-]`, cap 64 (Task 8 ruling)", () => {
    // D-MCP-1: this exact shape is what plugin-registry's `mcpServerKey`
    // composes for every plugin .mcp.json server; the old `{1,32}` grammar
    // made `mountMcpClient` refuse all of them at its first statement.
    const cfg: McpServerConfig = { transport: "stdio", serverName: "plugin:Marketplace_A__proxy:echo", command: "node", args: [] }
    expect(() => validateMcpConfig(cfg)).not.toThrow()
    const atCap: McpServerConfig = { transport: "stdio", serverName: "s".repeat(64), command: "node", args: [] }
    expect(() => validateMcpConfig(atCap)).not.toThrow()
  })

  it("throws on invalid serverName", () => {
    const cfg: McpServerConfig = { transport: "stdio", serverName: "bad name", command: "node", args: [] }
    expect(() => validateMcpConfig(cfg)).toThrow(/serverName/)
  })

  it("throws past the 64-char cap (the cap is pinned, not just the character set)", () => {
    const cfg: McpServerConfig = { transport: "stdio", serverName: "s".repeat(65), command: "node", args: [] }
    expect(() => validateMcpConfig(cfg)).toThrow(/serverName/)
  })

  it("throws on bad timeout", () => {
    const cfg: McpServerConfig = { transport: "stdio", serverName: "s", command: "node", args: [], toolCallTimeoutMs: -1 }
    expect(() => validateMcpConfig(cfg)).toThrow(/toolCallTimeoutMs/)
  })
})
