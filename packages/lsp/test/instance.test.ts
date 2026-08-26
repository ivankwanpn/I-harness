import { describe, expect, it } from "vitest"
import { pathToFileURL } from "node:url"
import { LspInstance, type InstanceSpec, type LspQuery } from "../src/index.ts"
import { createFakeLspServer } from "./fake-server.ts"

const DEF = "textDocument/definition"
const HOVER = "textDocument/hover"

const CAPS = { definitionProvider: true, referencesProvider: true, hoverProvider: true }
const FILE_A_TS = pathToFileURL("/w/a.ts").href // canonical form (win32: file:///D:/w/a.ts)
const RESULT_LOCS = [
  { uri: FILE_A_TS, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } } },
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

  it("rejects ready with LSP_INITIALIZE_TIMEOUT when initialize is never answered (bounded startup)", async () => {
    const server = createFakeLspServer({}) // no initialize script entry → request hangs
    const inst = new LspInstance(spec({ startupTimeoutMs: 50 }), server.spawner)
    const start = Date.now()
    await expect(inst.ready).rejects.toThrow(/LSP_INITIALIZE_TIMEOUT.*50/)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
    expect(Date.now() - start).toBeLessThan(2_000)
    await inst.dispose().catch(() => undefined) // cleanup: bounded teardown of the hung server
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
    expect(td.uri).toBe(FILE_A_TS)
    expect(td.languageId).toBe("ts")
    expect(td.version).toBe(1)
    expect(td.text).toBe("const x = 1")
    const close = server.server.notifications.find((n) => n.method === "textDocument/didClose")!
    expect(paramsOf(close).textDocument).toEqual({ uri: FILE_A_TS })
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

  it("normalizes malformed hover (undefined contents) to hover: null instead of JSON.stringify(undefined)", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, [HOVER]: {} })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.query({ operation: "hover", filePath: "/w/a.ts", line: 1, character: 1 }, "x")).resolves.toEqual({
      kind: "hover",
      hover: null,
    })
  })

  it("normalizes { locations: null } to empty instead of throwing (locs.length on null)", async () => {
    const server = createFakeLspServer({ initialize: { capabilities: CAPS }, [DEF]: { locations: null } })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.query(definition(), "x")).resolves.toEqual({ kind: "empty" })
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

  it("a capability-throwing query does not stall the queue", async () => {
    // referencesProvider is absent: the first query rejects at the capability check
    // (before didOpen); the queued definition query must still run (queue continuation).
    const server = createFakeLspServer({
      initialize: { capabilities: { definitionProvider: true } },
      [DEF]: { locations: RESULT_LOCS },
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    const p1 = inst.query({ operation: "findReferences", filePath: "/w/a.ts", line: 1, character: 1 }, "x")
    const p2 = inst.query(definition(), "x")
    await expect(p1).rejects.toThrow(/UNSUPPORTED|not support/i)
    await expect(p2).resolves.toEqual({ kind: "locations", locations: RESULT_LOCS })
    // findReferences never reached the wire (capability check precedes didOpen);
    // only the definition query touched the server, in strict order.
    expect(server.server.methods).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/definition",
      "textDocument/didClose",
    ])
  })
})

describe("LspInstance diagnostics", () => {
  const DIAG = "textDocument/diagnostic"
  const ITEM = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    severity: 1,
    message: "boom",
    source: "ts",
    code: "2322",
  }

  it("performs transient didOpen→diagnostic→didClose and unwraps { items } (discarding entries without a message)", async () => {
    const server = createFakeLspServer({
      initialize: { capabilities: CAPS },
      [DIAG]: () => ({
        items: [
          ITEM,
          { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } } }, // no message → discarded
          "junk", // non-object → discarded
        ],
      }),
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    const diags = await inst.diagnostics("/w/a.ts", "const x = 1")
    expect(diags).toEqual([ITEM])
    expect(server.server.methods).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      DIAG,
      "textDocument/didClose",
    ])
    const req = server.server.requests.find((r) => methodOf(r) === DIAG)!
    expect(paramsOf(req).textDocument).toEqual({ uri: FILE_A_TS })
  })

  it("normalizes null / plain-array payloads (fail-closed)", async () => {
    const server = createFakeLspServer({
      initialize: { capabilities: CAPS },
      [DIAG]: (params: unknown) => {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri
        return uri.endsWith("null.json") ? null : [ITEM]
      },
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    await expect(inst.diagnostics("/w/null.json", "x")).resolves.toEqual([])
    // plain-array form: passthrough (no { items } wrapper)
    await expect(inst.diagnostics("/w/a.ts", "x")).resolves.toEqual([ITEM])
  })

  it("serializes diagnostics with the queue (didOpen/didClose never interleave with a query)", async () => {
    let defCalls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((res) => {
      release = res
    })
    const server = createFakeLspServer({
      initialize: { capabilities: CAPS },
      [DEF]: () => {
        defCalls += 1
        if (defCalls === 1) return gate.then(() => ({ locations: [] }))
        return { locations: [] }
      },
      [DIAG]: () => ({ items: [] }),
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    const p1 = inst.diagnostics("/w/a.ts", "x")
    const p2 = inst.query(definition(), "x")
    // Release the second response only after the first (diagnostics) request has
    // fully closed — with a serialized queue the queued query's didOpen cannot
    // start before that.
    await waitFor(() => server.server.methods.filter((m) => m === "textDocument/didClose").length === 1)
    release?.()
    const [d1, d2] = await Promise.all([p1, p2])
    expect(d1).toEqual([])
    expect(d2.kind).toBe("empty")
    expect(server.server.methods).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      DIAG,
      "textDocument/didClose",
      "textDocument/didOpen",
      DEF,
      "textDocument/didClose",
    ])
  })
})

describe("LspInstance abort", () => {
  it("aborts a query: rejects it, sends $/cancelRequest with its id, still sends didClose, and the next queued query proceeds", async () => {
    let defCalls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((res) => {
      release = res
    })
    const server = createFakeLspServer({
      initialize: { capabilities: CAPS },
      [DEF]: () => {
        defCalls += 1
        // First definition hangs until the test decides; later ones answer immediately.
        return defCalls === 1 ? gate.then(() => ({ locations: RESULT_LOCS })) : { locations: RESULT_LOCS }
      },
    })
    const inst = new LspInstance(spec(), server.spawner)
    await inst.ready
    const ac = new AbortController()
    const p1 = inst.query(definition(), "const x = 1", ac.signal)
    const p2 = inst.query(definition({ line: 2 }), "const x = 1")
    // Wait until the first (hung) definition request is in flight, then abort it.
    await waitFor(() => server.server.methods.filter((m) => m === DEF).length === 1)
    ac.abort()
    // (a) the aborted query rejects
    await expect(p1).rejects.toThrow(/aborted/i)
    // (b) $/cancelRequest arrived, carrying the aborted request's id
    const defReq = server.server.requests.find((r) => methodOf(r) === DEF)
    const cancel = server.server.messages.find((m) => methodOf(m) === "$/cancelRequest")
    expect(cancel).toBeDefined()
    expect(paramsOf(cancel).id).toBe(defReq?.id)
    // (d) the next queued query proceeds to a successful result
    await expect(p2).resolves.toEqual({ kind: "locations", locations: RESULT_LOCS })
    // (c) the aborted query still closed its transient document; the queue stayed strictly serialized:
    // didOpen/definition/cancel/didClose of query 1 all precede query 2's didOpen.
    expect(server.server.methods).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      DEF,
      "$/cancelRequest",
      "textDocument/didClose",
      "textDocument/didOpen",
      DEF,
      "textDocument/didClose",
    ])
    release?.() // let the hung script promise settle — its late response is ignored by the connection
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
