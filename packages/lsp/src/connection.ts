// LSP JSON-RPC connection: request/notify/cancel/failAll over a spawned
// subprocess pipe, with Content-Length framing (dsh pattern, M18 pull model).
import { spawn } from "node:child_process"
import { MessageDecoder, encodeMessage } from "./protocol.ts"

export interface ConnectionSpec {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  maxMessageBytes: number // default 16MB
  maxStderrBytes: number // default 1MB
  killGraceMs: number // default 5000
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export type ServerRequestHandler = (method: string, params: unknown) => unknown | Promise<unknown>

export class LspConnection {
  private readonly decoder: MessageDecoder
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closeReason: Error | undefined
  private stderr = ""
  private child: ReturnType<typeof spawn> | undefined
  private readonly onServerRequest: ServerRequestHandler | undefined
  readonly closed: Promise<void>
  private resolveClosed!: () => void

  constructor(
    spec: ConnectionSpec,
    spawner: (spec: ConnectionSpec) => ReturnType<typeof spawn>,
    onServerRequest?: ServerRequestHandler,
  ) {
    this.decoder = new MessageDecoder(spec.maxMessageBytes)
    this.onServerRequest = onServerRequest
    this.closed = new Promise((res) => {
      this.resolveClosed = res
    })
    const child = spawner(spec)
    this.child = child
    child.stdout?.on("data", (d: Buffer) => this.onData(d))
    child.stderr?.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString("utf-8")).slice(-spec.maxStderrBytes)
    })
    child.on("close", () => {
      this.fail(this.closeReason ?? new Error("LSP process closed"))
      this.resolveClosed()
    })
    child.on("error", (e: Error) => {
      this.fail(e)
      this.resolveClosed()
    })
    child.stdin?.on("error", (e: Error) => {
      this.fail(e)
    })
  }

  get stderrTail(): string {
    return this.stderr
  }

  private onData(d: Buffer): void {
    let msgs: unknown[]
    try {
      msgs = this.decoder.push(d)
    } catch (e) {
      // fail-closed: an undecodable frame corrupts the stream — fail all pending.
      this.fail(e instanceof Error ? e : new Error(String(e)))
      return
    }
    for (const msg of msgs) {
      const m = msg as { id?: number; method?: string; result?: unknown; error?: unknown; params?: unknown }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!
        this.pending.delete(m.id)
        if (m.error !== undefined) p.reject(new Error(`LSP error: ${JSON.stringify(m.error)}`))
        else p.resolve(m.result)
      } else if (m.method !== undefined && m.id !== undefined) {
        // server->client REQUEST: JSON-RPC mandates a response or the server hangs.
        void this.handleServerRequest(m as { id: number; method: string; params?: unknown })
      }
      // server->client NOTIFICATION (method without id): ignored (M18 pull model) — no-op
    }
  }

  private async handleServerRequest(m: { id: number; method: string; params?: unknown }): Promise<void> {
    try {
      if (this.onServerRequest === undefined) {
        throw new Error(`no onServerRequest handler for "${m.method}"`)
      }
      const result = await this.onServerRequest(m.method, m.params)
      this.write({ jsonrpc: "2.0", id: m.id, result: result ?? null })
    } catch (e) {
      this.write({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32601, message: e instanceof Error ? e.message : String(e) },
      })
    }
  }

  private write(msg: unknown): void {
    this.child?.stdin?.write(encodeMessage(msg))
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"))
        return
      }
      const onAbort = () => {
        this.cancel(id)
        this.pending.delete(id)
        reject(new Error("aborted"))
      }
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort)
          resolve(v)
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort)
          reject(e)
        },
      })
      this.write({ jsonrpc: "2.0", id, method, params })
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  notify(method: string, params: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params })
    return Promise.resolve()
  }

  cancel(requestId: number): void {
    this.write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: requestId } })
  }

  /** Best-effort kill of the child process (used by the bounded teardown's kill escalation). */
  kill(): void {
    try {
      this.child?.kill()
    } catch {
      // best-effort: a kill on an already-dead process is a no-op
    }
  }

  fail(err: Error): void {
    // The first failure is the recorded reason (a later close event keeps the
    // root cause), but every call rejects whatever is pending — a request made
    // after a transient fail() must never hang on a later close.
    if (this.closeReason === undefined) this.closeReason = err
    const pending = Array.from(this.pending.values())
    this.pending.clear()
    for (const p of pending) p.reject(err)
  }
}

export function spawnLspConnection(
  spec: ConnectionSpec,
  spawner?: (spec: ConnectionSpec) => ReturnType<typeof spawn>,
  onServerRequest?: ServerRequestHandler,
): LspConnection {
  return new LspConnection(
    spec,
    spawner ?? ((s) => spawn(s.command, s.args, { cwd: s.cwd, env: s.env ? { ...process.env, ...s.env } : process.env, stdio: ["pipe", "pipe", "pipe"] })),
    onServerRequest,
  )
}
