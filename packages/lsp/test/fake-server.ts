// Shared fake LSP server for connection/instance/tool lifecycle tests.
// Simulates a spawned child process: the client writes client->server frames
// into child.stdin (decoded here via the package's own MessageDecoder) and the
// test drives server->client traffic by writing into child.stdout / child.stderr.
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { vi, type Mock } from "vitest"
import type { ConnectionSpec } from "../src/index.ts"
import { encodeMessage, MessageDecoder } from "../src/index.ts"

/** The fake child: a real EventEmitter with pipe-like stdio streams. */
export interface FakeChildProcess extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill: Mock<() => boolean>
}

export interface FakeChildServer {
  /** The fake child process object (register child.on("close"|"error"), child.stdin.on("error") on it). */
  child: FakeChildProcess
  /** A spawner compatible with the connection's spawner slot (type-cast, no `as never` at call sites). */
  spawner: (spec: ConnectionSpec) => ReturnType<typeof import("node:child_process").spawn>
  /** Every message the client wrote to stdin, decoded from raw Content-Length frames. */
  messages: unknown[]
  /** Every raw chunk the client wrote to stdin (Content-Length-framed bytes). */
  rawBytes: Buffer[]
  /** Simulate the server sending one JSON-RPC message to the client (framed write to stdout). */
  pushMessage(msg: unknown): void
  /** Simulate the server writing raw bytes to the client's stdout. */
  pushRaw(buf: Buffer): void
  /** Simulate the server writing text to the client's stderr. */
  writeStderr(text: string): void
  /** Simulate the child process closing (emit "close"). */
  close(): void
  /** Simulate a child-process-level error (emit "error"). */
  error(err: Error): void
  /** Simulate an error on the client->server stdin channel (emit "error" on child.stdin). */
  stdinError(err: Error): void
}

/** Script entry for a request method: a static response value, or a fn receiving the request params
 *  (may return static/async value — falsy-but-defined like `null`/`false`/0 are real responses; returning
 *  `undefined` means "don't respond", e.g. to exercise a timeout) or throwing → error response. */
export type LspScriptEntry = unknown | ((params: unknown) => unknown | Promise<unknown>)
/** Scripted-response map, keyed by LSP method name (e.g. `initialize`, `textDocument/definition`,
 *  `textDocument/hover`, `textDocument/references`, `shutdown`). Unscripted methods get no response
 *  (the request hangs — useful for timeout tests); notifications are always recorded and ignored. */
export type LspScript = Record<string, LspScriptEntry>

/** Request/notification log of a scripted fake LSP server (for assertions). */
export interface FakeLspServerLog {
  /** All decoded client→server messages, in order (same array as the channel's `messages`). */
  messages: unknown[]
  /** Ordered method names of every client→server message. */
  methods: string[]
  /** The client→server requests (messages carrying an id), in order. */
  requests: Array<Record<string, unknown>>
  /** The client→server notifications (no id), in order. */
  notifications: Array<Record<string, unknown>>
}

export interface FakeLspServerOptions {
  /** When true (default) the fake child emits "close" right after the client sends "exit"
   *  (simulates the real LSP teardown path). Set false to hold the process open and exercise
   *  the grace/kill escalation. */
  autoExit?: boolean
}

export interface FakeLspServer extends FakeChildServer {
  /** Scripted server request/notification log. */
  server: FakeLspServerLog
}

/**
 * Scripted fake LSP server on top of `createFakeChild`.
 * For every decoded client→server message it finds the script entry by `method`:
 * - request (id present): entry is the static response or a fn (called with params; may return
 *   `undefined` to not respond, or throw to emit a JSON-RPC error response) — the result is
 *   answered as `{ jsonrpc: "2.0", id, result }`.
 * - notification (no id): only recorded (plus, for "exit" with autoExit, the child "closes").
 * Notifications initialized/didOpen/didClose/exit never need script entries.
 * Return value spreads the whole channel (pushMessage/pushRaw/writeStderr/close/error/...)
 * plus `server` for assertions (e.g. `server.methods`, `server.notifications`).
 */
export function createFakeLspServer(script: LspScript = {}, opts: FakeLspServerOptions = {}): FakeLspServer {
  const autoExit = opts.autoExit ?? true
  const log: FakeLspServerLog = { messages: [], methods: [], requests: [], notifications: [] }
  const channel = createFakeChild({
    onMessage: (raw) => {
      const msg = raw as Record<string, unknown> & { method?: string; params?: unknown; id?: number | null }
      if (typeof msg.method === "string") log.methods.push(msg.method)
      if (msg.id === undefined || msg.id === null) {
        log.notifications.push(msg)
        if (msg.method === "exit" && autoExit) setImmediate(() => channel.child.emit("close"))
        return
      }
      log.requests.push(msg)
      const entry = typeof msg.method === "string" ? script[msg.method] : undefined
      if (entry === undefined) return // unscripted request: no response (caller's timeout decides)
      void (async () => {
        try {
          const result = typeof entry === "function" ? await (entry as (p: unknown) => unknown | Promise<unknown>)(msg.params) : entry
          if (result !== undefined) channel.pushMessage({ jsonrpc: "2.0", id: msg.id, result })
        } catch (e) {
          channel.pushMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
          })
        }
      })()
    },
  })
  // `messages` aliases the channel's own decoded log (same array) so both views agree.
  log.messages = channel.messages
  return { ...channel, server: log }
}

export function createFakeChild(opts?: { onMessage?: (msg: unknown) => void }): FakeChildServer {
  const child = new EventEmitter() as FakeChildProcess
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  child.kill = vi.fn(() => true)

  const messages: unknown[] = []
  const rawBytes: Buffer[] = []
  const decoder = new MessageDecoder(64 * 1024 * 1024)
  child.stdin.on("data", (chunk: Buffer) => {
    rawBytes.push(chunk)
    for (const msg of decoder.push(chunk)) {
      messages.push(msg)
      opts?.onMessage?.(msg)
    }
  })

  const spawner = ((_spec: ConnectionSpec) => child) as unknown as (spec: ConnectionSpec) => ReturnType<typeof import("node:child_process").spawn>

  return {
    child,
    spawner,
    messages,
    rawBytes,
    pushMessage(msg: unknown) {
      child.stdout.write(encodeMessage(msg))
    },
    pushRaw(buf: Buffer) {
      child.stdout.write(buf)
    },
    writeStderr(text: string) {
      child.stderr.write(Buffer.from(text, "utf-8"))
    },
    close() {
      child.emit("close")
    },
    error(err: Error) {
      child.emit("error", err)
    },
    stdinError(err: Error) {
      child.stdin.emit("error", err)
    },
  }
}
