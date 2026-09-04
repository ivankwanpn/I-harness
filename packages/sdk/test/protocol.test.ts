// M27 R-C4: NDJSON JSON-RPC 2.0 line framing — encode/decode round trip,
// malformed lines ignored, error codes -32700/-32603, line transport over
// real duplex streams, and the low-level client (request/notification).
import { describe, expect, it } from "vitest"
import { PassThrough } from "node:stream"
import { createInterface } from "node:readline"
import {
  encodeFrame,
  decodeFrame,
  makeRequest,
  makeNotification,
  makeSuccess,
  makeFailure,
  PARSE_ERROR,
  INTERNAL_ERROR,
  JsonRpcLineTransport,
  isRpcRequest,
  isRpcNotification,
  type RpcRequest,
} from "../src/protocol.ts"
import { HarnessClient } from "../src/client.ts"

describe("frame encoding", () => {
  it("round-trips a request; each frame is one NDJSON line", () => {
    const request = makeRequest(1, "session/prompt", { sessionId: "s", prompt: "hi" })
    expect(request).toMatchObject({ jsonrpc: "2.0", id: 1, method: "session/prompt" })
    const line = encodeFrame(request)
    expect(line.endsWith("\n")).toBe(true)
    expect(line.split("\n")).toHaveLength(2) // exactly one line + trailing newline
    expect(decodeFrame(line)).toEqual(request)
  })

  it("round-trips responses and notifications", () => {
    expect(decodeFrame(encodeFrame(makeSuccess(7, { ok: true })))).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } })
    expect(decodeFrame(encodeFrame(makeNotification("session/event", { sessionId: "s", event: { type: "turn/end" } })))).toEqual({
      jsonrpc: "2.0",
      method: "session/event",
      params: { sessionId: "s", event: { type: "turn/end" } },
    })
  })

  it("malformed lines are ignored: garbage / wrong shape / bad jsonrpc", () => {
    expect(decodeFrame("not-json {{{")).toBeUndefined()
    expect(decodeFrame("")).toBeUndefined()
    expect(decodeFrame('{"jsonrpc":"2.0"}')).toBeUndefined() // neither request nor notification
    expect(decodeFrame(encodeFrame({ jsonrpc: "1.0", id: 1, method: "x" } as unknown as RpcRequest))).toBeUndefined()
  })

  it("error codes: -32700 parse / -32603 internal error constants and frames", () => {
    expect(PARSE_ERROR).toBe(-32700)
    expect(INTERNAL_ERROR).toBe(-32603)
    const failure = makeFailure(9, INTERNAL_ERROR, "boom", { detail: "x" })
    expect(failure).toMatchObject({ jsonrpc: "2.0", id: 9, error: { code: -32603, message: "boom", data: { detail: "x" } } })
  })

  it("type guards distinguish request / notification", () => {
    expect(isRpcRequest(makeRequest(1, "m", {}))).toBe(true)
    expect(isRpcNotification(makeNotification("m", {}))).toBe(true)
    expect(isRpcRequest(makeNotification("m", {}))).toBe(false)
    expect(isRpcNotification(makeRequest(1, "m", {}))).toBe(false)
  })
})

describe("JsonRpcLineTransport", () => {
  it("delivers framed messages across two duplex streams; malformed lines never reach the listener", async () => {
    const clientRead = new PassThrough()
    const clientWrite = new PassThrough()
    const transport = new JsonRpcLineTransport(clientRead, clientWrite)
    const received: unknown[] = []
    const off = transport.onMessage((msg) => received.push(msg))

    // opposite side writes two lines: one garbage, one valid
    clientRead.write("garbage{{{ \n")
    clientRead.write(encodeFrame(makeRequest(1, "ping", {})))
    await new Promise((r) => setTimeout(r, 50))
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ method: "ping", id: 1 })
    off()
    clientRead.destroy()
  })

  it("send() writes exactly one frame", async () => {
    const sink = new PassThrough()
    const transport = new JsonRpcLineTransport(new PassThrough(), sink)
    let out = ""
    sink.on("data", (chunk) => { out += String(chunk) })
    transport.send(makeSuccess(3, "ok"))
    await new Promise((r) => setTimeout(r, 50))
    expect(out).toBe(JSON.stringify({ jsonrpc: "2.0", id: 3, result: "ok" }) + "\n")
  })
})

describe("HarnessClient (low level, in-process transport)", () => {
  /** A client linked to a manual in-process server (two PassThroughs). */
  function link(): {
    client: HarnessClient
    serverRead: PassThrough
    serverWrite: PassThrough
  } {
    const clientRead = new PassThrough() // server → client
    const clientWrite = new PassThrough() // client → server
    return {
      client: new HarnessClient(clientRead, clientWrite),
      serverRead: clientWrite,
      serverWrite: clientRead,
    }
  }

  function serve(rl: ReturnType<typeof createInterface>, write: PassThrough): void {
    rl.on("line", (line) => {
      const msg = decodeFrame(line)
      if (!isRpcRequest(msg)) return
      if (msg.method === "initialize") {
        write.write(encodeFrame(makeSuccess(msg.id, { name: "i-harness", protocolVersion: 1 })))
      } else if (msg.method === "notify-me") {
        write.write(encodeFrame(makeNotification("session/event", { sessionId: "s1", event: { type: "turn/end" } })))
        write.write(encodeFrame(makeSuccess(msg.id, { ok: true })))
      } else {
        write.write(encodeFrame(makeFailure(msg.id, INTERNAL_ERROR, "boom", { detail: "x" })))
      }
    })
  }

  it("request() resolves a success response", async () => {
    const { client, serverRead, serverWrite } = link()
    const rl = createInterface({ input: serverRead })
    serve(rl, serverWrite)
    try {
      const info = await client.request("initialize", {})
      expect(info).toMatchObject({ name: "i-harness", protocolVersion: 1 })
    } finally {
      rl.close()
      await client.close()
    }
  })

  it("request() rejects with an RpcError carrying the server code", async () => {
    const { client, serverRead, serverWrite } = link()
    const rl = createInterface({ input: serverRead })
    serve(rl, serverWrite)
    try {
      await expect(client.request("broken", {})).rejects.toMatchObject({ code: INTERNAL_ERROR })
      await expect(client.request("broken", {})).rejects.toBeInstanceOf(Error)
    } finally {
      rl.close()
      await client.close()
    }
  })

  it("onNotification delivers server → client notifications", async () => {
    const { client, serverRead, serverWrite } = link()
    const rl = createInterface({ input: serverRead })
    serve(rl, serverWrite)
    const notifications: unknown[] = []
    const off = client.onNotification((n) => notifications.push(n))
    try {
      await client.request("notify-me", {})
      expect(notifications).toHaveLength(1)
      const n = notifications[0] as { method: string; params: { event: { type: string } } }
      expect(n.method).toBe("session/event")
      expect(n.params.event.type).toBe("turn/end")
      off()
    } finally {
      rl.close()
      await client.close()
    }
  })

  it("notify() sends a request-less frame the server side can read", async () => {
    const { client, serverRead, serverWrite } = link()
    const server = new JsonRpcLineTransport(serverRead, serverWrite)
    const seen: unknown[] = []
    server.onMessage((msg) => seen.push(msg))
    try {
      client.notify("shutdown", {})
      await new Promise((r) => setTimeout(r, 50))
      expect(seen).toHaveLength(1)
      expect(isRpcNotification(seen[0]!)).toBe(true)
      expect((seen[0] as { method: string }).method).toBe("shutdown")
    } finally {
      server.close()
      await client.close()
    }
  })

  it("close() ends the write side (server sees stream end)", async () => {
    const { client, serverRead } = link()
    let ended = false
    serverRead.resume() // consume so 'end' propagates
    serverRead.on("end", () => { ended = true })
    await client.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(ended).toBe(true)
  })
})

describe("HarnessClient v1 helpers (history / listSessions, in-process transport)", () => {
  it("history() and listSessions() round-trip typed helpers over the in-process transport", async () => {
    const clientRead = new PassThrough() // server → client
    const clientWrite = new PassThrough() // client → server
    const client = new HarnessClient(clientRead, clientWrite)
    const rl = createInterface({ input: clientWrite })
    const seen: Array<{ method: string; params: unknown }> = []
    rl.on("line", (line) => {
      const msg = decodeFrame(line)
      if (!isRpcRequest(msg)) return
      seen.push({ method: msg.method, params: msg.params })
      if (msg.method === "session/history") {
        clientRead.write(encodeFrame(makeSuccess(msg.id, { events: [{ type: "turn/start", seq: 0 }], nextSeq: 1 })))
      } else if (msg.method === "session/list") {
        clientRead.write(encodeFrame(makeSuccess(msg.id, { sessions: [{ id: "s1", title: "t" }] })))
      } else {
        clientRead.write(encodeFrame(makeFailure(msg.id, INTERNAL_ERROR, "boom")))
      }
    })
    try {
      const range = await client.history("s1", { afterSeq: 7, limit: 3 })
      expect(range).toEqual({ events: [{ type: "turn/start", seq: 0 }], nextSeq: 1 })
      const list = await client.listSessions()
      expect(list).toEqual({ sessions: [{ id: "s1", title: "t" }] })
      // the wire params are exactly the typed options (undefined omitted)
      expect(seen).toEqual([
        { method: "session/history", params: { sessionId: "s1", afterSeq: 7, limit: 3 } },
        { method: "session/list", params: {} },
      ])
    } finally {
      rl.close()
      await client.close()
    }
  })
})
