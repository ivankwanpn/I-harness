import { describe, expect, it } from "vitest"
import { encodeMessage, MessageDecoder } from "../src/index.ts"

describe("encodeMessage", () => {
  it("produces Content-Length-delimited JSON-RPC", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const buf = encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    expect(buf.toString("utf-8")).toBe(`${header}${body}`)
  })
})

describe("MessageDecoder", () => {
  it("streams a single message across chunk splits", () => {
    const decoder = new MessageDecoder(10_000)
    const buf = encodeMessage({ jsonrpc: "2.0", id: 5, result: { ok: true } })
    const half = buf.subarray(0, 20)
    const rest = buf.subarray(20)
    expect(decoder.push(half)).toEqual([])
    const out = decoder.push(rest)
    expect(out).toEqual([{ jsonrpc: "2.0", id: 5, result: { ok: true } }])
  })

  it("decodes multiple messages in one chunk", () => {
    const decoder = new MessageDecoder(10_000)
    const a = encodeMessage({ jsonrpc: "2.0", id: 1, result: 1 })
    const b = encodeMessage({ jsonrpc: "2.0", id: 2, result: 2 })
    const out = decoder.push(Buffer.concat([a, b]))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: 1 }, { jsonrpc: "2.0", id: 2, result: 2 }])
  })

  it("throws on an oversize message (fail-loud)", () => {
    const decoder = new MessageDecoder(10)
    const big = encodeMessage({ jsonrpc: "2.0", id: 1, result: "x".repeat(100) })
    expect(() => decoder.push(big)).toThrow()
  })
})
