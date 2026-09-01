// M27 R-C4: NDJSON JSON-RPC 2.0 line framing for @i-harness/sdk.
//
// The wire contract: ONE JSON-RPC 2.0 message per line (JSON.stringify +
// "\n"). Malformed lines are IGNORED (never crash the loop, never an echo);
// request ids echo into responses; error codes follow JSON-RPC:
//   -32700 parse (a decoded line that is not a valid request object),
//   -32603 internal (anything the server method throws).
// This module is pure framing — no I/O. Zero dependencies.
//
// NOTE (external contract): this file IS the sdk wire contract. Any change to
// the shapes here is a breaking protocol change for embedders.

import { createInterface, type Interface } from "node:readline"
import type { Readable, Writable } from "node:stream"

export const PROTOCOL_VERSION = 1

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

export interface RpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

export interface RpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export interface RpcSuccess {
  jsonrpc: "2.0"
  id: number | string
  result: unknown
}

export interface RpcFailure {
  jsonrpc: "2.0"
  id: number | string
  error: { code: number; message: string; data?: unknown }
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure

/** Transport-level RpcError: an error RESPONSE from the server (the message
 * the client rejects with). */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "RpcError"
    this.code = code
    this.data = data
  }
}

export function makeRequest(id: number | string, method: string, params?: unknown): RpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params }
}

export function makeNotification(method: string, params?: unknown): RpcNotification {
  return params === undefined
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params }
}

export function makeSuccess(id: number | string, result: unknown): RpcSuccess {
  return { jsonrpc: "2.0", id, result }
}

export function makeFailure(id: number | string, code: number, message: string, data?: unknown): RpcFailure {
  return data === undefined
    ? { jsonrpc: "2.0", id, error: { code, message } }
    : { jsonrpc: "2.0", id, error: { code, message, data } }
}

export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return (
    typeof msg === "object"
    && msg !== null
    && !Array.isArray(msg)
    && (msg as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && typeof (msg as { method?: unknown }).method === "string"
    && (typeof (msg as { id?: unknown }).id === "number" || typeof (msg as { id?: unknown }).id === "string")
  )
}

export function isRpcNotification(msg: unknown): msg is RpcNotification {
  return (
    typeof msg === "object"
    && msg !== null
    && !Array.isArray(msg)
    && (msg as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && typeof (msg as { method?: unknown }).method === "string"
    && (msg as { id?: unknown }).id === undefined
  )
}

export function isRpcSuccess(msg: unknown): msg is RpcSuccess {
  return (
    typeof msg === "object"
    && msg !== null
    && (msg as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && "id" in msg
    && "result" in msg
    && !("error" in msg)
  )
}

export function isRpcFailure(msg: unknown): msg is RpcFailure {
  return (
    typeof msg === "object"
    && msg !== null
    && (msg as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && "id" in msg
    && typeof (msg as { error?: unknown }).error === "object"
    && (msg as { error?: unknown }).error !== null
  )
}

/** Encode one message as a single NDJSON line (trailing "\n"). */
export function encodeFrame(message: RpcMessage): string {
  return JSON.stringify(message) + "\n"
}

/** Decode one NDJSON line. Returns undefined for ANY malformed input
 * (non-JSON, wrong shape, old jsonrpc versions) — callers ignore those lines
 * (the framing contract). */
export function decodeFrame(line: string): RpcMessage | undefined {
  if (line === "" || line.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (isRpcRequest(parsed) || isRpcNotification(parsed) || isRpcSuccess(parsed) || isRpcFailure(parsed)) return parsed
  return undefined
}

/** NDJSON line transport over a readable (incoming lines) + writable
 * (outgoing frames). Malformed lines never reach listeners. */
export class JsonRpcLineTransport {
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private readonly rl: Interface
  private readonly output: Writable

  constructor(input: Readable, output: Writable) {
    this.output = output
    this.rl = createInterface({ input })
    this.rl.on("line", this.onLine)
  }

  private onLine = (line: string): void => {
    const message = decodeFrame(line)
    if (message === undefined) return // malformed → ignored (framing contract)
    for (const listener of [...this.listeners]) listener(message)
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  send(message: RpcMessage): void {
    this.output.write(encodeFrame(message))
  }

  /** End the output side (graceful shutdown — the peer sees stream end). */
  endWrite(): void {
    this.output.end()
  }

  /** Stop listening (does not destroy the streams; the client owns them). */
  close(): void {
    this.rl.off("line", this.onLine)
    this.listeners.clear()
  }
}
