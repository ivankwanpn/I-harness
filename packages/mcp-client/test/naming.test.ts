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

  it("rejects invalid names", () => {
    expect(() => assertServerName("bad name")).toThrow()
    expect(() => assertServerName("")).toThrow()
    expect(() => assertServerName("x".repeat(33))).toThrow()
  })
})
