import { describe, expect, it } from "vitest"
import { splitName, tokenize, searchText, search } from "../src/search.ts"

const TOOLS = [
  { name: "read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string", description: "file path" } } } },
  { name: "write", description: "write a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "grep", description: "search text in files", inputSchema: {}, searchHint: "find patterns" },
  { name: "list_dir", description: "list a directory", inputSchema: {} },
] as const

describe("tool-search BM25 core", () => {
  it("splitName splits CamelCase and separators", () => {
    expect(splitName("list_dir")).toBe("list dir")
    expect(splitName("myTool")).toBe("my Tool")
    expect(splitName("already lower")).toBe("already lower")
  })

  it("tokenize lowercases, splits, and drops stopwords", () => {
    expect(tokenize("Read The File")).toEqual(["read", "file"])
    expect(tokenize("list_dir of my Tools")).toEqual(["list", "dir", "tools"])
  })

  it("searchText includes name, split name, description, hint, and schema", () => {
    const text = searchText({ name: "list_dir", description: "list a directory", inputSchema: { type: "object", properties: { path: { type: "string", description: "a path" } } }, searchHint: "dirs" })
    expect(text).toContain("list_dir")
    expect(text).toContain("list dir")
    expect(text).toContain("directory")
    expect(text).toContain("dirs")
    expect(text).toContain("path")
    expect(text).toContain("a path")
  })

  it("exact tool-name query returns that tool", () => {
    const result = search("grep", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })
    expect(result.map((t) => t.name)).toEqual(["grep"])
  })

  it("BM25 keyword search ranks the best match first", () => {
    const result = search("find patterns", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]!.name).toBe("grep") // searchHint "find patterns" boosts it
  })

  it("select: prefix returns exact names", () => {
    const result = search("select:read,write", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })
    expect(result.map((t) => t.name)).toEqual(["read", "write"])
  })

  it("select: with unknown name throws", () => {
    expect(() => search("select:nope", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })).toThrow(/unknown/i)
  })

  it("+term required semantics: a tool must contain the required term", () => {
    const result = search("+text grep", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })
    // "text" appears in grep's description ("search text in files") and read's
    // schema? No — read/write don't contain "text". Only grep matches.
    expect(result.map((t) => t.name)).toEqual(["grep"])
  })

  it("empty query throws", () => {
    expect(() => search("   ", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })).toThrow(/empty/i)
  })

  it("limit bounds are enforced", () => {
    expect(() => search("x", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8, limit: 0 })).toThrow(/limit/i)
    expect(() => search("x", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8, limit: 21 })).toThrow(/limit/i)
    expect(() => search("x", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8, limit: 2.5 })).toThrow(/limit/i)
  })
})
