import { describe, expect, it, vi } from "vitest"
import { MessageDecoder, spawnLspConnection, type ConnectionSpec } from "../src/index.ts"
import { createFakeChild } from "./fake-server.ts"

function spec(overrides?: Partial<ConnectionSpec>): ConnectionSpec {
  return {
    command: "fake-lsp",
    args: ["--stdio"],
    cwd: ".",
    maxMessageBytes: 10_000,
    maxStderrBytes: 100,
    killGraceMs: 100,
    ...overrides,
  }
}

/** Decode one client->server message back off the fake's raw output (validates real framing). */
function decodeLast(fake: ReturnType<typeof createFakeChild>): Record<string, unknown> {
  expect(fake.rawBytes.length).toBeGreaterThan(0)
  const decoder = new MessageDecoder(10_000)
  const decoded: unknown[] = []
  for (const chunk of fake.rawBytes) {
    for (const msg of decoder.push(chunk)) decoded.push(msg)
  }
  expect(decoded.length).toBe(1)
  return decoded[0] as Record<string, unknown>
}

describe("LspConnection request", () => {
  it("sends a request framed with Content-Length and correct JSON-RPC body", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    void conn.request("initialize", { processId: 1 })
    const sent = decodeLast(fake)
    expect(sent).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: 1 } })
  })

  it("routes out-of-order responses to the right pending request by id", async () => {
    const traces: { id?: number }[] = []
    const fake = createFakeChild({ onMessage: (msg) => traces.push(msg as { id?: number }) })
    const conn = spawnLspConnection(spec(), fake.spawner)
    const p1 = conn.request("a", {})
    const id1 = (traces[0] as { id: number }).id
    const p2 = conn.request("b", {})
    const id2 = (traces[1] as { id: number }).id
    // server answers id2 first, then id1
    fake.pushMessage({ jsonrpc: "2.0", id: id2, result: "b-result" })
    fake.pushMessage({ jsonrpc: "2.0", id: id1, result: "a-result" })
    await expect(p1).resolves.toBe("a-result")
    await expect(p2).resolves.toBe("b-result")
  })

  it("rejects a request when the response carries an error object", async () => {
    const traces: { id?: number }[] = []
    const fake = createFakeChild({ onMessage: (msg) => traces.push(msg as { id?: number }) })
    const conn = spawnLspConnection(spec(), fake.spawner)
    const p = conn.request("shutdown", {})
    const id = (traces[0] as { id: number }).id
    fake.pushMessage({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } })
    await expect(p).rejects.toThrow(/boom/)
  })

  it("aborts a pending request and sends $/cancelRequest when the signal fires", async () => {
    const traces: { method?: string }[] = []
    const fake = createFakeChild({ onMessage: (msg) => traces.push(msg as { method?: string }) })
    const conn = spawnLspConnection(spec(), fake.spawner)
    const ac = new AbortController()
    const p = conn.request("textDocument/hover", {}, ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow(/aborted/)
    // two frames were written: the original request and the cancel notification
    expect(fake.messages).toHaveLength(2)
    const [req, cancel] = fake.messages as [Record<string, unknown>, Record<string, unknown>]
    expect(req.method).toBe("textDocument/hover")
    expect(cancel.method).toBe("$/cancelRequest")
    expect((cancel.params as { id: number }).id).toBe(req.id)
    expect(cancel.id).toBeUndefined()
  })

  it("cancel() sends $/cancelRequest for the given id", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    conn.cancel(7)
    const sent = decodeLast(fake)
    expect(sent).toEqual({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 7 } })
  })
})

describe("LspConnection notify", () => {
  it("sends a notification framed with Content-Length and no id", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    await conn.notify("textDocument/didOpen", { textDocument: { uri: "file:///a.ts" } })
    expect(fake.messages).toHaveLength(1)
    const sent = fake.messages[0] as Record<string, unknown>
    expect(sent).toEqual({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: "file:///a.ts" } },
    })
    expect(sent.id).toBeUndefined()
    // and it was actually framed on the wire: decode the raw bytes
    expect(decodeLast(fake)).toEqual(sent)
  })

  it("ignore()s server->client notifications (M18 pull model)", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    fake.pushMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {} })
    void conn
    await new Promise((r) => setTimeout(r, 10))
    expect(fake.messages.filter((m) => (m as { method?: string }).method !== undefined)).toHaveLength(0)
  })
})

describe("LspConnection server->client requests", () => {
  it("routes a server request to onServerRequest and writes a result response with the same id", async () => {
    const fake = createFakeChild()
    const onServerRequest = vi.fn(async (method: string, params: unknown) => ({ handled: method, params }))
    const conn = spawnLspConnection(spec(), fake.spawner, onServerRequest)
    fake.pushMessage({ jsonrpc: "2.0", id: 9, method: "workspace/configuration", params: { items: [] } })
    void conn
    await new Promise((r) => setTimeout(r, 10))
    expect(onServerRequest).toHaveBeenCalledOnce()
    expect(onServerRequest).toHaveBeenCalledWith("workspace/configuration", { items: [] })
    const sent = decodeLast(fake)
    expect(sent).toEqual({ jsonrpc: "2.0", id: 9, result: { handled: "workspace/configuration", params: { items: [] } } })
  })

  it("writes an error response when the server request handler throws", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner, async () => {
      throw new Error("unsupported")
    })
    fake.pushMessage({ jsonrpc: "2.0", id: 11, method: "workspace/executeCommand", params: {} })
    void conn
    await new Promise((r) => setTimeout(r, 10))
    const sent = decodeLast(fake)
    expect(sent).toEqual({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32601, message: "unsupported" },
    })
  })

  it("writes an error response when no onServerRequest handler is provided", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    fake.pushMessage({ jsonrpc: "2.0", id: 12, method: "workspace/executeCommand", params: {} })
    void conn
    await new Promise((r) => setTimeout(r, 10))
    const sent = decodeLast(fake)
    expect(sent).toEqual({
      jsonrpc: "2.0",
      id: 12,
      error: { code: -32601, message: expect.stringContaining("no onServerRequest") },
    })
  })
})

describe("LspConnection failAll", () => {
  it("rejects all pending requests (and no more are resolved) on connection close", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    const p1 = conn.request("a", {})
    const p2 = conn.request("b", {})
    fake.close()
    await expect(p1).rejects.toThrow(/closed/i)
    await expect(p2).rejects.toThrow(/closed/i)
  })

  it("rejects pending requests with the process error on child 'error'", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    const p = conn.request("initialize", {})
    fake.error(new Error("spawn ENOENT"))
    await expect(p).rejects.toThrow(/ENOENT/)
  })

  it("fails pending requests (stdin error is fatal) and ignores later responses", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    const p = conn.request("initialize", {})
    const id = fake.messages[0] as { id: number }
    fake.stdinError(new Error("EPIPE"))
    await expect(p).rejects.toThrow(/EPIPE/)
    fake.pushMessage({ jsonrpc: "2.0", id: id.id, result: "late" })
    await expect(p).rejects.toThrow(/EPIPE/) // already settled
  })

  it("fail(err) rejects pending, and later requests still work if not closed", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    const p = conn.request("a", {})
    conn.fail(new Error("boom"))
    await expect(p).rejects.toThrow(/boom/)
    // fail() does not terminate the connection; a new request is still written
    void conn.request("b", {})
    expect(fake.messages).toHaveLength(2)
  })
})

describe("LspConnection stderr tail", () => {
  it("bounds stderrTail to the last maxStderrBytes", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec({ maxStderrBytes: 10 }), fake.spawner)
    fake.writeStderr("0123456789abcdefghij") // 20 bytes
    await new Promise((r) => setTimeout(r, 10))
    expect(conn.stderrTail).toBe("0123456789abcdefghij".slice(-10))
  })
})

describe("LspConnection closed", () => {
  it("resolves closed after the process closes", async () => {
    const fake = createFakeChild()
    const conn = spawnLspConnection(spec(), fake.spawner)
    let settled = false
    void conn.closed.then(() => {
      settled = true
    })
    fake.close()
    await conn.closed
    expect(settled).toBe(true)
  })
})
