import { describe, expect, it } from "vitest"
import { MAX_PUBLIC_NAME_LENGTH, assertServerName, publicToolName } from "../src/index.ts"

describe("publicToolName", () => {
  it("clean case: mcp__<serverName>__<rawName>", () => {
    expect(publicToolName("files", "read_file")).toBe("mcp__files__read_file")
  })

  it("sanitizes invalid characters to _", () => {
    // Sanitizing changes the name, so the stable-identity hash is appended.
    expect(publicToolName("my-server", "read file")).toBe("mcp__my-server__read_file_7570397964fd")
  })

  it("appends a hash when the name exceeds 64 chars (no collapse of distinct identities)", () => {
    const long = "x".repeat(80)
    const a = publicToolName("s", `tool-${long}`)
    const b = publicToolName("s", `tool-${long}-other`)
    expect(a.length).toBeLessThanOrEqual(MAX_PUBLIC_NAME_LENGTH)
    expect(b.length).toBeLessThanOrEqual(MAX_PUBLIC_NAME_LENGTH)
    expect(a).not.toBe(b) // distinct identities never collapse
  })

  it("appends a hash when sanitation changes the name", () => {
    const dirty = "tool with spaces!!!"
    const name = publicToolName("s", dirty)
    expect(name).toMatch(/^mcp__s__tool_with_spaces____[0-9a-f]{12}$/)
  })

  it("hashes when the whole parse would be ambiguous (__ in either segment)", () => {
    const a = publicToolName("a", "b__c")
    const b = publicToolName("a__b", "c")
    expect(a).not.toBe(b)
    expect(a).toMatch(/[0-9a-f]{12}$/)
  })
})

describe("assertServerName", () => {
  it("accepts valid names", () => {
    expect(() => assertServerName("files")).not.toThrow()
    expect(() => assertServerName("my-server_1")).not.toThrow()
  })

  it("accepts the namespace grammar — `[A-Za-z0-9_.:-]`, cap 64 (Task 8 ruling)", () => {
    // The colon is the namespace separator plugin-registry's `mcpServerKey`
    // composes with; before D-MCP-1's fix neither validator knew it, so every
    // plugin MCP server was refused at the mount's first line.
    expect(() => assertServerName("plugin:hello:mcp")).not.toThrow()
    expect(() => assertServerName("plugin:Marketplace_A__proxy:echo")).not.toThrow()
    expect(() => assertServerName("svc.v1:west")).not.toThrow()
    expect(() => assertServerName("x".repeat(64))).not.toThrow()
  })

  it("rejects invalid names", () => {
    expect(() => assertServerName("bad name")).toThrow()
    expect(() => assertServerName("")).toThrow()
    expect(() => assertServerName("sla/sh")).toThrow()
    expect(() => assertServerName("x".repeat(65))).toThrow()
  })
})
