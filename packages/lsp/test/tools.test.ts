// Tools tests for createLspTools: stub LspInstance (spies for query/diagnostics),
// REAL temp files for the readFile path (Ruling 24), extension routing (Ruling 23),
// and the diagnostics line filter (Ruling 22).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createLspTools, type LspDiagnostic, type LspInstance, type LspQueryResult, type LspToolConfig } from "../src/index.ts"

function makeConfig(languages: string[] = [".ts"]): LspToolConfig {
  return { serverName: "ts", command: "ts-lsp", args: [], cwd: ".", languages }
}

/** Stub instance with call spies for query/diagnostics/dispose (Ruling 27). */
function makeStub() {
  const query = vi.fn(async () => ({ kind: "empty" } as LspQueryResult))
  const diagnostics = vi.fn(async () => [] as LspDiagnostic[])
  const dispose = vi.fn(async () => {})
  const instance = { query, diagnostics, dispose } as unknown as LspInstance
  return { instance, query, diagnostics, dispose }
}

describe("createLspTools", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-lsp-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("creates the lsp + lsp_diagnostics tools (read-only, concurrency-safe)", () => {
    const { instance } = makeStub()
    const tools = createLspTools(instance, makeConfig(), dir)
    expect(tools.map((t) => t.name)).toEqual(["lsp", "lsp_diagnostics"])
    for (const t of tools) {
      // Ruling 25: LSP queries are idempotent reads of the workspace; the instance
      // serializes internally so both tools are marked read-only + concurrency-safe.
      expect(t.isReadOnly).toBe(true)
      expect(t.isConcurrencySafe).toBe(true)
    }
  })

  it("lsp tool forwards the operation + 1-based position (absolute path) and renders empty as 'No results.'", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    const { instance, query } = makeStub()
    const tools = createLspTools(instance, makeConfig(), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    const out = await lsp.execute({ operation: "goToDefinition", file_path: "a.ts", line: 2, character: 4 }, {})
    expect(query).toHaveBeenCalledWith(
      { operation: "goToDefinition", filePath: join(dir, "a.ts"), line: 2, character: 4 },
      "const x = 1\n",
      undefined,
    )
    expect(out).toBe("No results.")
  })

  it("lsp tool routes locations through formatLocations (workspace-relative, 1-based)", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    const locations = [
      { uri: `file://${dir.replace(/\\/g, "/")}/a.ts`, range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } },
    ]
    const { instance, query } = makeStub()
    query.mockResolvedValue({ kind: "locations", locations })
    const tools = createLspTools(instance, makeConfig(), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    const out = await lsp.execute({ operation: "goToDefinition", file_path: "a.ts", line: 1, character: 4 }, {})
    expect(out).toBe("a.ts:1:4-1:8")
  })

  it("lsp tool routes hover through formatHover", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    const { instance, query } = makeStub()
    query.mockResolvedValue({ kind: "hover", hover: { contents: "hello doc" } })
    const tools = createLspTools(instance, makeConfig(), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    const out = await lsp.execute({ operation: "hover", file_path: "a.ts", line: 1, character: 1 }, {})
    expect(out).toBe("hello doc")
    expect(query).toHaveBeenCalledWith(
      { operation: "hover", filePath: join(dir, "a.ts"), line: 1, character: 1 },
      "const x = 1\n",
      undefined,
    )
  })

  it("lsp tool throws LSP_NO_SERVER_FOR_FILE for an unmounted extension before reading/querying", async () => {
    writeFileSync(join(dir, "b.js"), "var x = 1\n")
    const { instance, query } = makeStub()
    const tools = createLspTools(instance, makeConfig([".ts"]), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    await expect(lsp.execute({ operation: "hover", file_path: "b.js", line: 1, character: 1 }, {})).rejects.toThrow(
      /LSP_NO_SERVER_FOR_FILE/,
    )
    expect(query).not.toHaveBeenCalled()
  })

  it("language routing strips a leading dot and compares case-insensitively", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    const { instance, query } = makeStub()
    const tools = createLspTools(instance, makeConfig([".TS"]), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    await lsp.execute({ operation: "hover", file_path: "a.ts", line: 1, character: 1 }, {})
    expect(query).toHaveBeenCalled()
  })

  it("lsp_diagnostics calls instance.diagnostics with the file path + source and renders severity/source", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    const diags: LspDiagnostic[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "boom", source: "ts" },
    ]
    const { instance, diagnostics } = makeStub()
    diagnostics.mockResolvedValue(diags)
    const tools = createLspTools(instance, makeConfig(), dir)
    const diagTool = tools.find((t) => t.name === "lsp_diagnostics")!
    const out = await diagTool.execute({ file_path: "a.ts" }, {})
    expect(diagnostics).toHaveBeenCalledWith(join(dir, "a.ts"), "const x = 1\n", undefined)
    expect(out).toBe("1:1 [Error] ts: boom")
  })

  it("lsp_diagnostics renders 'No diagnostics.' when the server returns none", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    const { instance, diagnostics } = makeStub()
    diagnostics.mockResolvedValue([])
    const tools = createLspTools(instance, makeConfig(), dir)
    const diagTool = tools.find((t) => t.name === "lsp_diagnostics")!
    const out = await diagTool.execute({ file_path: join(dir, "a.ts") }, {})
    expect(diagnostics).toHaveBeenCalledWith(join(dir, "a.ts"), "const x = 1\n", undefined)
    expect(out).toBe("No diagnostics.")
  })

  it("lsp_diagnostics line filter: only diagnostics overlapping the cursor line; character alone is ignored", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    const all: LspDiagnostic[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "on-line-1" },
      { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 5 } }, severity: 2, message: "on-line-5" },
      { range: { start: { line: 1, character: 0 }, end: { line: 3, character: 5 } }, severity: 3, message: "spans-2-4" },
    ]
    const { instance, diagnostics } = makeStub()
    diagnostics.mockResolvedValue(all)
    const tools = createLspTools(instance, makeConfig(), dir)
    const diagTool = tools.find((t) => t.name === "lsp_diagnostics")!

    const line1 = await diagTool.execute({ file_path: "a.ts", line: 1 }, {}) // 0-based cursor 0
    expect(line1).toContain("on-line-1")
    expect(line1).not.toContain("on-line-5")
    expect(line1).not.toContain("spans-2-4")

    const line3 = await diagTool.execute({ file_path: "a.ts", line: 3 }, {}) // 0-based cursor 2: overlaps spans-2-4
    expect(line3).toContain("spans-2-4")
    expect(line3).not.toContain("on-line-1")
    expect(line3).not.toContain("on-line-5")

    const noLine = await diagTool.execute({ file_path: "a.ts" }, {}) // all shown
    expect(noLine).toContain("on-line-1")
    expect(noLine).toContain("on-line-5")
    expect(noLine).toContain("spans-2-4")

    const charOnly = await diagTool.execute({ file_path: "a.ts", character: 3 }, {}) // character alone ignored
    expect(charOnly).toContain("on-line-5")
    expect(charOnly).toContain("spans-2-4")
  })

  it("lsp_diagnostics character filter: with line+character, the exact cursor range must contain the cursor in BOTH dimensions", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    // Both diagnostics sit on line 0; the cursor on line 1 (0-based 0).
    const all: LspDiagnostic[] = [
      // Character range 0-2: contains cursor char 1 (1-based line 1, char 2 → 0-based 1) → kept
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, severity: 1, message: "wide-tight" },
      // Character range 5-8: does NOT contain cursor char 1 → filtered out when character given
      { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } }, severity: 2, message: "wide-not-at-cursor" },
    ]
    const { instance, diagnostics } = makeStub()
    diagnostics.mockResolvedValue(all)
    const tools = createLspTools(instance, makeConfig(), dir)
    const diagTool = tools.find((t) => t.name === "lsp_diagnostics")!

    const withChar = await diagTool.execute({ file_path: "a.ts", line: 1, character: 2 }, {})
    expect(withChar).toContain("wide-tight")
    expect(withChar).not.toContain("wide-not-at-cursor")

    const lineOnly = await diagTool.execute({ file_path: "a.ts", line: 1 }, {}) // line-only keeps both
    expect(lineOnly).toContain("wide-tight")
    expect(lineOnly).toContain("wide-not-at-cursor")
  })

  it("forwards the abortSignal to instance.query and instance.diagnostics", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1\n")
    const { instance, query, diagnostics } = makeStub()
    const tools = createLspTools(instance, makeConfig(), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    const diagTool = tools.find((t) => t.name === "lsp_diagnostics")!
    const ac = new AbortController()
    await lsp.execute({ operation: "hover", file_path: "a.ts", line: 1, character: 1 }, { abortSignal: ac.signal })
    expect(query).toHaveBeenCalledWith(expect.anything(), expect.anything(), ac.signal)
    await diagTool.execute({ file_path: "a.ts" }, { abortSignal: ac.signal })
    expect(diagnostics).toHaveBeenCalledWith(expect.anything(), expect.anything(), ac.signal)
  })
})

describe("M26-B5 lsp tool operations", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-lsp5-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("documentSymbol renders formatSymbols text (file_path only, no position)", async () => {
    writeFileSync(join(dir, "a.ts"), "function main() {}\n")
    const { instance, query } = makeStub()
    query.mockResolvedValue({ kind: "symbols", symbols: [{ name: "main", kind: 12, uri: pathToFileURL(join(dir, "a.ts")).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] } as never)
    const tools = createLspTools(instance, makeConfig(), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    const out = await lsp.execute({ operation: "documentSymbol", file_path: "a.ts" }, {})
    expect(query).toHaveBeenCalledWith({ operation: "documentSymbol", filePath: join(dir, "a.ts") }, "function main() {}\n", undefined)
    expect(String(out)).toContain("main [12]")
  })

  it("workspaceSymbol sends query and renders 'No symbols.' for empty", async () => {
    const { instance, query } = makeStub()
    query.mockResolvedValue({ kind: "symbols", symbols: [] } as never)
    const tools = createLspTools(instance, makeConfig(), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    const out = await lsp.execute({ operation: "workspaceSymbol", query: "util" }, {})
    expect(query).toHaveBeenCalledWith({ operation: "workspaceSymbol", query: "util" }, "", undefined)
    expect(out).toBe("No symbols.")
  })

  it("callHierarchy returns structured items; incomingCalls/outgoingCalls return direction+target+calls", async () => {
    writeFileSync(join(dir, "a.ts"), "function main() {}\n")
    const { instance, query } = makeStub()
    const item = { name: "callee", kind: 12, uri: "file:///w/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } }
    query.mockResolvedValueOnce({ kind: "callHierarchy", items: [item] } as never)
    query.mockResolvedValueOnce({ kind: "calls", calls: [{ item: { name: "caller", kind: 12, uri: "file:///w/a.ts", range: item.range, selectionRange: item.range }, fromRanges: [{ start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }] }], direction: "incoming", target: item } as never)
    const tools = createLspTools(instance, makeConfig(), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    const prep = (await lsp.execute({ operation: "callHierarchy", file_path: "a.ts", line: 1, character: 1 }, {})) as { items: unknown[] }
    expect(prep.items).toHaveLength(1)
    const calls = (await lsp.execute({ operation: "incomingCalls", item }, {})) as { direction: string; target: { name: string }; calls: Array<{ from: { name: string }; at: string }> }
    expect(calls.direction).toBe("incoming")
    expect(calls.target.name).toBe("callee")
    expect(calls.calls[0]!.from.name).toBe("caller")
    expect(calls.calls[0]!.at).toContain("2:3-2:8")
  })

  it("rejects missing per-operation params (fail-loud, no server roundtrip)", async () => {
    const { instance, query } = makeStub()
    const tools = createLspTools(instance, makeConfig(), dir)
    const lsp = tools.find((t) => t.name === "lsp")!
    await expect(lsp.execute({ operation: "documentSymbol" }, {})).rejects.toThrow(/requires file_path/)
    await expect(lsp.execute({ operation: "workspaceSymbol" }, {})).rejects.toThrow(/requires query/)
    await expect(lsp.execute({ operation: "incomingCalls" }, {})).rejects.toThrow(/requires item/)
    expect(query).not.toHaveBeenCalled()
  })
})
