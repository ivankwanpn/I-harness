import { describe, expect, it } from "vitest"
import { formatLocations, formatHover, formatDiagnostics, formatSymbols, formatCallHierarchyCalls } from "../src/index.ts"
import { normalizeLocations, normalizeHover } from "../src/index.ts"

describe("render", () => {
  it("formatLocations groups by file and renders 1-based positions", () => {
    const out = formatLocations({ kind: "locations", locations: [
      { uri: "file:///w/a.ts", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } },
    ] }, { workspaceRoot: "/w", maxLocations: 100, maxResultChars: 16000 })
    expect(out).toContain("a.ts:1:4-1:8")
  })

  it("formatLocations caps at maxLocations and appends an omission marker", () => {
    const locs = Array.from({ length: 150 }, (_, i) => ({ uri: `file:///w/a.ts`, range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } } }))
    const out = formatLocations({ kind: "locations", locations: locs }, { workspaceRoot: "/w", maxLocations: 100, maxResultChars: 16000 })
    expect(out).toContain("(50 omitted)")
  })

  it("formatHover renders contents and a null hover", () => {
    expect(formatHover({ kind: "hover", hover: { contents: "hello" } }, { maxResultChars: 16000 })).toContain("hello")
    expect(formatHover({ kind: "hover", hover: null }, { maxResultChars: 16000 })).toContain("No hover information")
  })

  it("formatHover renders the hover range as a trailing 1-based range line", () => {
    const out = formatHover(
      { kind: "hover", hover: { contents: "doc", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } } },
      { maxResultChars: 16000 },
    )
    expect(out).toBe("doc\n1:4-1:8")
  })

  it("formatHover truncates at maxResultChars with the … marker", () => {
    const out = formatHover({ kind: "hover", hover: { contents: "x".repeat(200) } }, { maxResultChars: 100 })
    expect(out.length).toBe(102) // 100 chars + "\n…"
    expect(out.endsWith("…")).toBe(true)
  })

  it("formatDiagnostics truncates at maxResultChars with the … marker", () => {
    const out = formatDiagnostics(
      [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "m".repeat(200) }],
      { maxResults: 50, maxResultChars: 100 },
    )
    expect(out.length).toBe(102) // 100 chars + "\n…"
    expect(out.endsWith("…")).toBe(true)
  })

  it("formatDiagnostics renders severity + position + message", () => {
    const out = formatDiagnostics([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "syntax error", source: "tsc" },
    ], { workspaceRoot: "/w", maxResults: 50 })
    expect(out).toContain("Error")
    expect(out).toContain("1:1")
    expect(out).toContain("syntax error")
  })

  it("formatLocations renders the file path as-is when workspaceRoot is absent", () => {
    const out = formatLocations({ kind: "locations", locations: [
      { uri: "file:///w/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ] }, { maxLocations: 100, maxResultChars: 16000 })
    expect(out).toMatch(/^\/w\/a\.ts:1:1-1:2/)
  })

  it("formatLocations slices a workspaceRoot with a trailing slash without truncating", () => {
    const out = formatLocations({ kind: "locations", locations: [
      { uri: "file:///w/a.ts", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } },
    ] }, { workspaceRoot: "/w/", maxLocations: 100, maxResultChars: 16000 })
    expect(out).toBe("a.ts:1:4-1:8")
  })

  it("formatLocations slices canonical win32 file:///C:/... URIs relative to a C:/ws-style root (drive-insensitive)", () => {
    const out = formatLocations({ kind: "locations", locations: [
      { uri: "file:///C:/ws/a.ts", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } },
    ] }, { workspaceRoot: "c:/ws", maxLocations: 100, maxResultChars: 16000 })
    expect(out).toBe("a.ts:1:4-1:8")
  })

  it("formatLocations renders a canonical file:///D:/... URI workspace-relative under a D:/ws root and decodes percent-escapes", () => {
    const out = formatLocations({ kind: "locations", locations: [
      { uri: "file:///D:/ws/b%20c.ts", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } },
    ] }, { workspaceRoot: "D:/ws", maxLocations: 100, maxResultChars: 16000 })
    expect(out).toBe("b c.ts:1:4-1:8")
  })

  it("formatDiagnostics renders a 1-based position for a multi-line range", () => {
    const out = formatDiagnostics([
      { range: { start: { line: 1, character: 2 }, end: { line: 3, character: 9 } }, severity: 2, message: "unused var", source: "tsc" },
    ], { workspaceRoot: "/w", maxResults: 50 })
    expect(out).toContain("Warning")
    expect(out).toContain("2:3")
    expect(out).toContain("unused var")
  })

  it("formatDiagnostics caps at maxResults and appends the omission marker", () => {
    const diags = Array.from({ length: 60 }, (_, i) => ({
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
      severity: 3,
      message: `msg ${i}`,
    }))
    const out = formatDiagnostics(diags, { workspaceRoot: "/w", maxResults: 50 })
    expect(out).toContain("(10 more diagnostics)")
    expect(out.split("\n")).toHaveLength(51)
  })

  it("formatDiagnostics renders 'No diagnostics.' for an empty list", () => {
    expect(formatDiagnostics([], { workspaceRoot: "/w", maxResults: 50 })).toBe("No diagnostics.")
  })
})

describe("translate", () => {
  it("normalizeLocations accepts a plain array and a { locations } wrapper", () => {
    const loc = { uri: "file:///w/a.ts", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } }
    expect(normalizeLocations([loc])).toEqual([loc])
    expect(normalizeLocations({ locations: [loc] })).toEqual([loc])
  })

  it("normalizeLocations fails closed to [] and discards malformed entries", () => {
    expect(normalizeLocations(null)).toEqual([])
    expect(normalizeLocations(42)).toEqual([])
    expect(normalizeLocations({ locations: null })).toEqual([])
    const good = { uri: "file:///w/a.ts", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } }
    const bad = { uri: 123, range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } }
    expect(normalizeLocations([good, bad])).toEqual([good])
    expect(normalizeLocations([bad])).toEqual([])
  })

  it("normalizeHover handles null, string contents, object contents and range", () => {
    expect(normalizeHover(null)).toBeNull()
    expect(normalizeHover("hello")).toBeNull()
    expect(normalizeHover({})).toBeNull()
    expect(normalizeHover({ contents: "hello" })).toEqual({ contents: "hello" })
    expect(normalizeHover({ contents: { value: "x" } })).toEqual({ contents: JSON.stringify({ value: "x" }) })
    expect(normalizeHover({ contents: "hello", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }))
      .toEqual({ contents: "hello", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } })
  })

  it("normalizeHover treats null contents as malformed", () => {
    expect(normalizeHover({ contents: null })).toBeNull()
    expect(normalizeHover({ contents: undefined })).toBeNull()
  })
})

describe("M26-B5 render", () => {
  const URI = "file:///D:/w/a.ts"

  it("formatSymbols renders one line per symbol with kind + workspace-relative loc + detail", () => {
    const out = formatSymbols([
      { name: "main", kind: 12, uri: URI, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 20 } }, detail: "function" },
      { name: "inner", kind: 13, uri: URI, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } } },
    ], { workspaceRoot: "D:/w" })
    expect(out).toBe(`main [12] a.ts:1:5-1:21 — function${String.fromCharCode(10)}inner [13] a.ts:2:3-2:8`)
  })

  it("formatCallHierarchyCalls renders incoming/outgoing semantic lines", () => {
    const target = { name: "callee", kind: 12, uri: URI, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }
    const call = { item: { name: "caller", kind: 12, uri: URI, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } }, selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } } }, fromRanges: [{ start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }] }
    expect(formatCallHierarchyCalls([call], target, "incoming", { workspaceRoot: "D:/w" })).toBe("caller calls callee at a.ts:2:3-2:8")
    expect(formatCallHierarchyCalls([call], target, "outgoing", { workspaceRoot: "D:/w" })).toBe("callee calls caller at a.ts:2:3-2:8")
    expect(formatCallHierarchyCalls([], target, "incoming", {})).toBe("No calls.")
  })
})
