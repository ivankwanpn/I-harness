// M27 R-C4: SDK client — low-level JSON-RPC exchange over an NDJSON line
// transport (in-process or a spawned `i-harness sdk` subprocess) plus the
// high-level run(session) surface. Zero new dependencies (node:child_process
// + node:stream only).
import { spawn, type ChildProcess } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import type { SessionEvent } from "@i-harness/core-session"
import {
  JsonRpcLineTransport,
  makeNotification,
  makeRequest,
  RpcError,
  type HistoryRange,
  type RpcFailure,
  type RpcNotification,
  type RpcSuccess,
  type SessionListResult,
  type CancelResult,
  type RewindPointsResponse,
  type RewindPlanResponse,
  type RewindExecuteResponse,
  type RewindMode,
} from "./protocol.ts"

export interface ServerInfo {
  name: string
  version: string
  protocolVersion: number
  capabilities: Record<string, string[]>
}

/** The connection itself failed (spawn error / exit / closed stream). */
export class SdkConnectionError extends Error {
  readonly code = "sdk-connection" as const

  constructor(message: string) {
    super(`[sdk-connection] ${message}`)
    this.name = "SdkConnectionError"
  }
}

/** The server rejected the run (submit failure — the turn ended in error). */
export class SdkRunError extends Error {
  readonly code: number
  readonly data: unknown
  readonly events: SessionEvent[]

  constructor(message: string, code: number, data: unknown, events: SessionEvent[]) {
    super(message)
    this.name = "SdkRunError"
    this.code = code
    this.data = data
    this.events = events
  }
}

export interface RunInput {
  /** Existing session id; absent → one-shot run with a server-generated id. */
  sessionId?: string
  prompt: string
}

export interface RunResult {
  sessionId: string
  /** The session events streamed during the run (turn log: turn/start …
   * whole run's events). */
  events: SessionEvent[]
  /** The final assistant/message text, when present. */
  text?: string
}

export interface QueueState {
  running: boolean
  queued: number
}

/** M41a v1: session/history paging options (all optional — defaults live in
 * the server: afterSeq 0, limit 500 capped at 1000). */
export interface HistoryOptions {
  afterSeq?: number
  limit?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

const REQUEST_TIMEOUT_MS = 60_000

export class HarnessClient {
  private readonly transport: JsonRpcLineTransport
  private nextId = 1
  private pending = new Map<string, Pending>()
  private notificationListeners = new Set<(notification: RpcNotification) => void>()
  private exitError: Error | undefined
  private child: ChildProcess | undefined
  private closed = false

  constructor(readable: Readable, writable: Writable, opts?: { child?: ChildProcess }) {
    this.transport = new JsonRpcLineTransport(readable, writable)
    this.transport.onMessage((message) => this.onMessage(message))
    const child = opts?.child
    if (child !== undefined) {
      this.child = child
      child.once("error", (error) => {
        this.exitError = new SdkConnectionError(`sdk subprocess error: ${error.message}`)
        this.rejectAll(this.exitError)
      })
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.exitError = new SdkConnectionError(
          `sdk subprocess exited (code ${code ?? "null"}, signal ${signal ?? "null"})`,
        )
        this.rejectAll(this.exitError)
      }
      child.once("exit", onExit)
    }
  }

  /** Spawn `command args...` and take its stdio as the transport. */
  static spawn(opts: {
    command: string
    args?: string[]
    cwd?: string
    env?: Record<string, string | undefined>
  }): HarnessClient {
    const child = spawn(opts.command, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    return new HarnessClient(child.stdout, child.stdin, { child })
  }

  /** Issue one request; resolves with the result, rejects with RpcError
   * (server error response) or SdkConnectionError (no server). */
  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.exitError !== undefined) return Promise.reject(this.exitError)
    if (this.closed) return Promise.reject(new SdkConnectionError("client is closed"))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SdkConnectionError(`request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.transport.send(makeRequest(id, method, params))
    })
  }

  /** Fire-and-forget notification (e.g. shutdown). */
  notify(method: string, params?: unknown): void {
    if (this.closed || this.exitError !== undefined) return
    this.transport.send(makeNotification(method, params))
  }

  /** Server → client notifications (e.g. session/event, session/status). */
  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => { this.notificationListeners.delete(listener) }
  }

  /** High-level per-session handle. */
  session(sessionId: string): HarnessSession {
    return new HarnessSession(this, sessionId)
  }

  /** High-level one-shot or continued run: streams the session events and
   * resolves when the turn completed. A failed turn rejects with SdkRunError
   * (the collected events ride along). */
  async run(input: RunInput): Promise<RunResult> {
    const sessionId = input.sessionId
      ?? `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const events: SessionEvent[] = []
    const off = this.onNotification((notification) => {
      if (notification.method !== "session/event") return
      const params = notification.params as { sessionId?: string; event?: SessionEvent } | undefined
      if (params !== undefined && params.sessionId === sessionId && params.event !== undefined) {
        events.push(params.event)
      }
    })
    try {
      await this.request("session/prompt", { sessionId, prompt: input.prompt })
    } catch (error) {
      if (error instanceof RpcError) {
        throw new SdkRunError(
          error.message,
          error.code,
          error.data,
          events,
        )
      }
      throw error
    } finally {
      off()
    }
    const last = [...events].reverse().find(
      (event): event is Extract<SessionEvent, { type: "assistant/message" }> => event.type === "assistant/message",
    )
    return { sessionId, events, ...(last !== undefined ? { text: last.text } : {}) }
  }

  async status(sessionId: string): Promise<QueueState> {
    const state = await this.request("session/status", { sessionId })
    return state as QueueState
  }

  /** M41a v1: walk a session's live event log from `afterSeq` (exclusive),
   * paging up to `limit` events. Rejects with RpcError(-32602, "session not
   * found") for an unknown session. */
  async history(sessionId: string, opts: HistoryOptions = {}): Promise<HistoryRange> {
    const params: { sessionId: string; afterSeq?: number; limit?: number } = { sessionId }
    if (opts.afterSeq !== undefined) params.afterSeq = opts.afterSeq
    if (opts.limit !== undefined) params.limit = opts.limit
    const result = await this.request("session/history", params)
    return result as HistoryRange
  }

  /** M41a v1: list store sessions. `listingUnavailable` is true when the
   * server has no listing source (an honest "unknown", not a real empty). */
  async listSessions(): Promise<SessionListResult> {
    const result = await this.request("session/list", {})
    return result as SessionListResult
  }

  /** M41b v1.1: abort the session's in-flight submit (the server aborts the
   * per-session AbortController session/prompt created). `cancelled` false +
   * reason "not-running" (known, idle) or "not-found" (server never saw the
   * session) — an honest answer, never an error frame. */
  async cancel(sessionId: string): Promise<CancelResult> {
    const result = await this.request("session/cancel", { sessionId })
    return result as CancelResult
  }

  /** M41b v1.1: the rewind engine's durable points of a live session.
   * Rejects with RpcError(-32602, "session not found") for an unknown
   * session, -32603 "rewind not enabled" when the host wired no rewind seam. */
  async rewindPoints(sessionId: string): Promise<RewindPointsResponse> {
    const result = await this.request("session/rewind/points", { sessionId })
    return result as RewindPointsResponse
  }

  /** M41b v1.1: the lazy two-phase rewind dry run (engine plan against the
   * target turn — clean/conflicts/unTracked/ops; wire shapes mirror
   * packages/rewind). */
  async rewindPlan(sessionId: string, target: number, mode: RewindMode): Promise<RewindPlanResponse> {
    const result = await this.request("session/rewind/plan", { sessionId, target, mode })
    return result as RewindPlanResponse
  }

  /** M41b v1.1: apply the rewind — file restore + the rewind/point
   * conversation marker appended to the live session log (flows on
   * session/event). */
  async rewindExecute(sessionId: string, target: number, mode: RewindMode): Promise<RewindExecuteResponse> {
    const result = await this.request("session/rewind/execute", { sessionId, target, mode })
    return result as RewindExecuteResponse
  }

  /** Graceful close: shutdown notification, end the write side, await the
   * subprocess exit (kill after 2s when the server does not exit). */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.notify("shutdown")
    } catch { /* best-effort */ }
    try {
      this.transport.endWrite()
    } catch { /* already ended */ }
    const child = this.child
    if (child !== undefined) {
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
      ])
      if (!exited) child.kill()
    }
    this.transport.close()
  }

  private onMessage(message: RpcSuccess | RpcFailure | RpcNotification): void {
    if ("result" in message || "error" in message) {
      const pending = this.pending.get(String(message.id))
      if (pending === undefined) return
      this.pending.delete(String(message.id))
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      if ("result" in message) {
        pending.resolve(message.result)
      } else {
        const failure = message as RpcFailure
        pending.reject(new RpcError(failure.error.code, failure.error.message, failure.error.data))
      }
      return
    }
    // notification
    for (const listener of [...this.notificationListeners]) listener(message as RpcNotification)
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

export class HarnessSession {
  constructor(private readonly client: HarnessClient, readonly sessionId: string) {}

  run(prompt: string): Promise<RunResult> {
    return this.client.run({ sessionId: this.sessionId, prompt })
  }

  status(): Promise<QueueState> {
    return this.client.status(this.sessionId)
  }

  /** M41a v1: history walk for this session (afterSeq exclusive, limit paging). */
  history(opts?: HistoryOptions): Promise<HistoryRange> {
    return this.client.history(this.sessionId, opts)
  }

  /** M41b v1.1: abort this session's in-flight submit. */
  cancel(): Promise<CancelResult> {
    return this.client.cancel(this.sessionId)
  }

  /** M41b v1.1: this session's rewind points. */
  rewindPoints(): Promise<RewindPointsResponse> {
    return this.client.rewindPoints(this.sessionId)
  }

  /** M41b v1.1: rewind dry run against `target` (turn index) in `mode`. */
  rewindPlan(target: number, mode: RewindMode): Promise<RewindPlanResponse> {
    return this.client.rewindPlan(this.sessionId, target, mode)
  }

  /** M41b v1.1: apply the rewind to this session. */
  rewindExecute(target: number, mode: RewindMode): Promise<RewindExecuteResponse> {
    return this.client.rewindExecute(this.sessionId, target, mode)
  }
}

/** Factory: spawn + wrap. */
export function createHarnessClient(opts: {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}): HarnessClient {
  return HarnessClient.spawn(opts)
}

/** One-shot convenience: run one prompt through a freshly spawned server.
 * `command` defaults to `i-harness` (PATH); pass `process.execPath` +
 * --import tsx + the CLI entry in tests. */
export async function runHarness(
  input: string | RunInput,
  opts?: { command?: string; args?: string[]; cwd?: string; keepAlive?: boolean },
): Promise<RunResult> {
  const command = opts?.command ?? "i-harness"
  const client = createHarnessClient({
    command,
    args: opts?.args ?? [],
    cwd: opts?.cwd,
  })
  try {
    return await client.run(typeof input === "string" ? { prompt: input } : input)
  } finally {
    if (opts?.keepAlive !== true) await client.close()
  }
}
