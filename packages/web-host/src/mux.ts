import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import type { ApprovalResponseWire, ClientMessage, Endpoint, QuestionResponseWire, ServerMessage } from "./types.ts"

export type StreamOpener = (
  endpoint: Endpoint,
  payload: unknown,
  signal: AbortSignal,
) => Promise<AsyncIterable<unknown>>

// Client messages the mux itself does not serve (not open/cancel) are routed
// to these handlers — e.g. `{type:"approval"}` decisions go to the host's
// ApprovalMuxBridge (controller ruling 1) and `{type:"answer"}` answers to
// the host's QuestionMuxBridge (task 3.3).
export interface MuxMessageHandlers {
  onApproval?: (value: ApprovalResponseWire) => void
  onAnswer?: (value: QuestionResponseWire) => void
}

interface ActiveStream {
  abort: AbortController
  done: Promise<void>
}

// Slow-consumer cap for MuxConnection.send() — see the comment there.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

export class WebSocketMuxServer {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly connections = new Set<Promise<void>>()
  private heartbeatTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly opener: StreamOpener,
    private readonly handlers: MuxMessageHandlers = {},
  ) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      this.startHeartbeat()
      const connection = new MuxConnection(websocket, this.opener, this.handlers)
      const done = connection.run()
      this.connections.add(done)
      void done.then(() => this.connections.delete(done))
    })
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await Promise.all(this.connections)
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return
    // Note (review, accepted minor): ping-only heartbeat — there is no
    // pong-timeout liveness check, so a silently-dead peer is reaped by TCP
    // timeouts or the next failed write, not proactively. Add
    // terminate-on-missing-pong here if that ever matters.
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.server.clients) {
        if (socket.readyState === WebSocket.OPEN) socket.ping()
      }
    }, 30_000)
    this.heartbeatTimer.unref()
  }
}

class MuxConnection {
  private readonly streams = new Map<string, ActiveStream>()
  private writes = Promise.resolve()

  constructor(
    private readonly socket: WebSocket,
    private readonly opener: StreamOpener,
    private readonly handlers: MuxMessageHandlers = {},
  ) {}

  async run(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.socket.once("close", resolve)
      this.socket.once("error", () => { this.socket.terminate() })
      this.socket.on("message", (data, isBinary) => {
        if (isBinary) {
          this.socket.close(1003, "text messages required")
          return
        }
        try {
          this.receive(rawText(data))
        } catch {
          this.socket.close(1008, "invalid request")
        }
      })
    })
    const active = [...this.streams.values()]
    for (const stream of active) stream.abort.abort(new Error("socket closed"))
    await Promise.all(active.map(stream => stream.done))
  }

  private receive(text: string): void {
    const message: ClientMessage = JSON.parse(text)
    if (message.type === "cancel") {
      this.streams.get(message.streamId)?.abort.abort(new Error("cancelled"))
      return
    }
    if (message.type === "approval") {
      // Client approval decision (controller ruling 1) — NOT an open: it
      // references an already-open approval stream, so it must be handled
      // BEFORE the duplicate-stream check below. The streamId identifies the
      // stream being answered; the decision itself is keyed by the globally
      // unique approvalId inside `value`.
      // Review fix (task 3.3 r1): a malformed `value` (e.g. `value: 42` or a
      // missing value) must never throw out of receive() — the connection
      // would be closed (1008) and every stream torn down. Non-object values
      // are dropped; the waterfall fails closed on its own timeout.
      if (typeof message.value === "object" && message.value !== null) {
        this.handlers.onApproval?.(message.value)
      }
      return
    }
    if (message.type === "answer") {
      // Client question answer (task 3.3) — the approval ruling 1 pattern
      // mirrored: handled before the duplicate-stream check, keyed by the
      // globally unique questionId inside `value`. Same malformed-value guard
      // as approval above: a bad frame is dropped, never a socket kill.
      if (typeof message.value === "object" && message.value !== null) {
        this.handlers.onAnswer?.(message.value)
      }
      return
    }
    if (this.streams.has(message.streamId)) {
      throw new Error(`duplicate stream ${message.streamId}`)
    }
    const abort = new AbortController()
    const active: ActiveStream = { abort, done: Promise.resolve() }
    this.streams.set(message.streamId, active)
    const done = this.pump(message.streamId, message.endpoint, message.payload, active)
    active.done = done
    const remove = (): void => { this.streams.delete(message.streamId) }
    void done.then(remove, remove)
  }

  private async pump(
    streamId: string,
    endpoint: Endpoint,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    try {
      await this.send({ type: "ready", streamId })
      const source = await this.opener(endpoint, payload, active.abort.signal)
      for await (const value of source) {
        await this.send({ type: "item", streamId, value })
      }
      if (!active.abort.signal.aborted) await this.send({ type: "end", streamId })
    } catch (error) {
      if (!active.abort.signal.aborted && this.socket.readyState === WebSocket.OPEN) {
        try {
          await this.send({ type: "error", streamId, error: String(error) })
        } catch {
          this.socket.close(1011, "stream failure could not be delivered")
        }
      }
    }
  }

  private send(message: ServerMessage): Promise<void> {
    // Slow-consumer bound (review note, kept deliberately cheap — no
    // per-stream accounting): if a client stops reading, ws buffers outgoing
    // frames without limit. Once the socket's buffered bytes cross the cap,
    // shed the connection (close 1008 policy-violation; 1026 is not a valid
    // close code). Subsequent sends reject on readyState below, the pumps
    // unwind, and run()'s close handler reaps the streams.
    if (this.socket.readyState === WebSocket.OPEN && this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.socket.close(1008, "slow consumer: buffered output exceeds cap")
    }
    const text = JSON.stringify(message)
    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error("socket closed"))
        return
      }
      this.socket.send(text, (err) => err ? reject(err) : resolve())
    }))
    this.writes = delivery.catch(() => {})
    return delivery
  }
}

function rawText(data: RawData): string {
  return data.toString("utf8")
}
