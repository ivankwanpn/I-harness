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
