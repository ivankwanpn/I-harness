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

  it("throws on invalid serverName", () => {
    const cfg: McpServerConfig = { transport: "stdio", serverName: "bad name", command: "node", args: [] }
    expect(() => validateMcpConfig(cfg)).toThrow(/serverName/)
  })

  it("throws on bad timeout", () => {
    const cfg: McpServerConfig = { transport: "stdio", serverName: "s", command: "node", args: [], toolCallTimeoutMs: -1 }
    expect(() => validateMcpConfig(cfg)).toThrow(/toolCallTimeoutMs/)
  })
})
