import { describe, expect, it } from "vitest"
import { LspInstance, type InstanceSpec, type LspQuery } from "../src/index.ts"
import { createFakeLspServer } from "./fake-server.ts"

const DEF = "textDocument/definition"
const HOVER = "textDocument/hover"

const CAPS = { definitionProvider: true, referencesProvider: true, hoverProvider: true }
const RESULT_LOCS = [
  { uri: "file:///w/a.ts", range: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } } },
]

function spec(overrides?: Partial<InstanceSpec>): InstanceSpec {
  return {
    command: "fake-lsp",
    args: ["--stdio"],
    cwd: ".",
    maxMessageBytes: 10_000,
    maxStderrBytes: 100,
    killGraceMs: 100,
    shutdownTimeoutMs: 100,
    ...overrides,
  }
}

function methodOf(msg: unknown): string | undefined {
  return (msg as { method?: string }).method
}

function paramsOf(msg: unknown): Record<string, unknown> {
  return (msg as { params?: Record<string, unknown> }).params ?? {}
}

function definition(overrides?: Partial<LspQuery>): LspQuery {
  return { operation: "goToDefinition", filePath: "/w/a.ts", line: 1, character: 3, ...overrides }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out")
    await sleep(5)
  }
}

describe("LspInstance ready", () => {
  it("resolves after initialize + initialized handshake, forwarding initializeOptions", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS } })
    const inst = new LspInstance(spec({ initializeOptions: { projectRoot: "/w" } }), server.spawner)
    await inst.ready
    expect(server.server.messages).toHaveLength(2)
    const [initMsg, initializedMsg] = server.server.messages
    expect(methodOf(initMsg)).toBe("initialize")
    const init = paramsOf(initMsg)
    expect(init.processId).toBe(process.pid)
    expect(init.rootUri).toBeNull()
    expect(init.capabilities).toEqual({})
    expect(init.initializationOptions).toEqual({ projectRoot: "/w" })
    expect((initMsg as { id?: number }).id).toBeTypeOf("number")
    expect(methodOf(initializedMsg)).toBe("initialized")
    expect((initializedMsg as { id?: number }).id).toBeUndefined()
  })
})

describe("LspInstance query", () => {
  it("performs transient didOpen→definition→didClose with the source text", async () => {
    const server = createFakeLspServer({
      initialize: { capabilities: CAPS },
      [DEF]: { locations: RESULT_LOCS },
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    const result = await inst.query(definition(), "const x = 1")
    expect(result).toEqual({ kind: "locations", locations: RESULT_LOCS })
    expect(server.server.methods).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/definition",
      "textDocument/didClose",
    ])
    const open = server.server.notifications.find((n) => n.method === "textDocument/didOpen")!
    const td = paramsOf(open).textDocument as { uri: string; languageId: string; version: number; text: string }
    expect(td.uri).toBe("file:///w/a.ts")
    expect(td.languageId).toBe("ts")
    expect(td.version).toBe(1)
    expect(td.text).toBe("const x = 1")
    const close = server.server.notifications.find((n) => n.method === "textDocument/didClose")!
    expect(paramsOf(close).textDocument).toEqual({ uri: "file:///w/a.ts" })
  })

  it("maps 1-based query positions to 0-based wire positions", async () => {
    const server = createFakeLspServer({
      initialize: { capabilities: CAPS },
      [DEF]: { locations: [] },
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await inst.query(definition({ line: 1, character: 3 }), "x")
    const defMsg = server.server.messages.find((m) => methodOf(m) === DEF)!
    expect(paramsOf(defMsg).position).toEqual({ line: 0, character: 2 })
  })

  it("adds the references context for findReferences", async () => {
    const server = createFakeLspServer({
      initialize: { capabilities: CAPS },
      "textDocument/references": { locations: [] },
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await inst.query({ operation: "findReferences", filePath: "/w/a.ts", line: 1, character: 1 }, "x")
    const refMsg = server.server.messages.find((m) => methodOf(m) === "textDocument/references")!
    expect(paramsOf(refMsg).context).toEqual({ includeDeclaration: true })
  })

  it("throws LSP_UNSUPPORTED_OPERATION when the server lacks the capability", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: { definitionProvider: true } } })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.query({ operation: "hover", filePath: "/w/a.ts", line: 1, character: 1 }, "x")).rejects.toThrow(
      /UNSUPPORTED|not support/i,
    )
  })

  it("accepts capability objects as supported (only false/undefined are missing)", async () => {
    const server = createFakeLspServer({
      initialize: { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: { workDoneProgress: true } } },
      [HOVER]: null,
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.query({ operation: "hover", filePath: "/w/a.ts", line: 1, character: 1 }, "x")).resolves.toEqual({
      kind: "hover",
      hover: null,
    })
  })

  it("normalizes a null hover to { kind: 'hover', hover: null }", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, [HOVER]: null })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.query({ operation: "hover", filePath: "/w/a.ts", line: 1, character: 1 }, "x")).resolves.toEqual({
      kind: "hover",
      hover: null,
    })
  })

  it("normalizes string hover contents", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, [HOVER]: { contents: "hello" } })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.query({ operation: "hover", filePath: "/w/a.ts", line: 1, character: 1 }, "x")).resolves.toEqual({
      kind: "hover",
      hover: { contents: "hello" },
    })
  })

  it("stringifies MarkupContent hover contents and keeps the range", async () => {
    const contents = { kind: "markdown", value: "doc" }
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, [HOVER]: { contents, range } })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.query({ operation: "hover", filePath: "/w/a.ts", line: 1, character: 1 }, "x")).resolves.toEqual({
      kind: "hover",
      hover: { contents: JSON.stringify(contents), range },
    })
  })

  it("returns empty when locations is empty", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, [DEF]: { locations: [] } })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.query(definition(), "x")).resolves.toEqual({ kind: "empty" })
  })

  it("handles the bare-array locations form", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, [DEF]: RESULT_LOCS })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.query(definition(), "x")).resolves.toEqual({ kind: "locations", locations: RESULT_LOCS })
  })

  it("serializes concurrent queries (didOpen/didClose pairs never interleave)", async () => {
    let defCalls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((res) => {
      release = res
    })
    const server = createFakeLspServer({
      initialize: { capabilities: CAPS },
      [DEF]: () => {
        defCalls += 1
        if (defCalls === 1) return { locations: RESULT_LOCS }
        return gate.then(() => ({ locations: RESULT_LOCS }))
      },
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    const p1 = inst.query(definition(), "const x = 1")
    const p2 = inst.query(definition({ line: 2 }), "const x = 1")
    // Release the second response only after the first query has fully closed —
    // with a serialized queue the second didOpen cannot even start before that.
    await waitFor(() => server.server.methods.filter((m) => m === "textDocument/didClose").length === 1)
    release?.()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.kind).toBe("locations")
    expect(r2.kind).toBe("locations")
    expect(server.server.methods).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/definition",
      "textDocument/didClose",
      "textDocument/didOpen",
      "textDocument/definition",
      "textDocument/didClose",
    ])
  })
})

describe("LspInstance dispose", () => {
  it("sends shutdown→exit and settles when the server exits normally (no kill)", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await inst.dispose()
    const methods = server.server.methods
    const shutdownIdx = methods.indexOf("shutdown")
    const exitIdx = methods.indexOf("exit")
    expect(shutdownIdx).toBeGreaterThanOrEqual(0)
    expect(exitIdx).toBeGreaterThan(shutdownIdx)
    expect(server.child.kill).not.toHaveBeenCalled()
    await inst.dispose() // idempotent: second call no-ops
  })

  it("kills after the grace period when the server does not exit (bounded settle)", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null }, { autoExit: false })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    const start = Date.now()
    await inst.dispose()
    const elapsed = Date.now() - start
    expect(server.child.kill).toHaveBeenCalled()
    expect(elapsed).toBeGreaterThanOrEqual(90) // the grace window (~killGraceMs) elapsed
    expect(elapsed).toBeLessThan(2_000)
  })

  it("proceeds to exit+kill when the shutdown request is never answered", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS } }, { autoExit: false })
    const inst = new LspInstance(spec({ shutdownTimeoutMs: 50, killGraceMs: 50 }), server.spawner)
    await inst.ready
    const start = Date.now()
    await inst.dispose()
    expect(server.child.kill).toHaveBeenCalled()
    expect(server.server.methods).toContain("exit")
    expect(Date.now() - start).toBeGreaterThanOrEqual(80) // shutdown timeout + grace
    expect(Date.now() - start).toBeLessThan(2_000)
  })

  it("rejects queries after dispose", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, shutdown: null })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await inst.dispose()
    await expect(inst.query(definition(), "x")).rejects.toThrow(/disposed/i)
  })
})
