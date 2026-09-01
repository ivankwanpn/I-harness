// M27 R-C4b: the SessionService-backed SDK server — in-process JSON-RPC
// handler over the C-region SessionService. The CLI wires it to stdio
// (`i-harness sdk`); an embedder can wire it to any duplex.
//
// Wire contract (methods):
//   initialize             → { name, version, protocolVersion, capabilities }
//   session/prompt {sessionId, prompt}
//                          → { sessionId, ok: true }    when the turn drained;
//                            error response -32603 on a failed turn (data.event
//                            carries the collected events)
//   session/status {sessionId} → { running, queued }
//   shutdown               → { ok: true } (then onShutdown fires)
// Notifications (server → client):
//   session/event  { sessionId, event }   — every appended session event
//   session/status { sessionId, status, error? } — lifecycle transitions
// Malformed lines are ignored; unknown methods get -32601; invalid params -32602.
import { subscribe, type SessionEvent } from "@i-harness/core-session"
import type { SessionService } from "@i-harness/session-executor"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import {
  encodeFrame,
  isRpcNotification,
  isRpcRequest,
  makeFailure,
  makeNotification,
  makeSuccess,
  decodeFrame,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  INTERNAL_ERROR,
  PROTOCOL_VERSION,
  type RpcMessage,
  type RpcNotification,
} from "./protocol.ts"

export const SDK_SERVER_NAME = "i-harness"
export const SDK_SERVER_PROTOCOL_VERSION = PROTOCOL_VERSION

export interface SdkServerOptions {
  /** Server → client writer (responses AND notifications both flow here when
   * provided; see also onNotify for notifications only). */
  onWrite?: (message: RpcMessage) => void
  /** Notification-only sink (session/event, session/status). */
  onNotify?: (message: RpcNotification) => void
  /** Session creation source — when given, session/prompt auto-creates an
   * unknown session before submit (durability requires the session to exist). */
  coordinator?: SessionCoordinator
  /** Server info version payload (defaults to "0.1.0"). */
  version?: string
  /** Fired after a successful shutdown request. */
  onShutdown?: () => void
}

export interface SdkServer {
  /** Handle one incoming line; returns the RESPONSE line (null when the line
   * produced no response — malformed lines, notifications, fire-and-forget).
   * Async methods (session/prompt) resolve their response late; notifications
   * are pushed as they happen via onNotify. */
  handleLine(line: string): Promise<string | null>
  /** Notification sink (server → client). */
  onNotify(cb: (message: RpcNotification) => void): () => void
  /** Idempotent teardown: detaches the assembly bridges. */
  close(): Promise<void>
}

/** A session/prompt submission in flight (per-session serialization needed to
 * keep the notification stream ordered for the client). */
interface Inflight {
  prompt: string
}

export function createSdkServer(service: SessionService, opts: SdkServerOptions = {}): SdkServer {
  const notifiers = new Set<(message: RpcNotification) => void>()
  const knownSessions = new Set<string>()
  const creatingSessions = new Set<string>()
  const inflight = new Map<string, Inflight>()
  let closed = false

  const pushNotify = (message: RpcNotification): void => {
    opts.onNotify?.(message)
    for (const cb of [...notifiers]) cb(message)
  }

  const pushMessage = (message: RpcMessage): void => {
    opts.onWrite?.(message)
    if (isRpcNotification(message)) pushNotify(message)
  }

  // Session event bridge: one subscription per live assembly — every appended
  // session/event flows to the client. Detached on close.
  const assemblyUnsubscribes = new Map<string, () => void>()
  const offAssembly = service.onAssembly((assembly) => {
    if (assembly.sessionId === undefined) return
    const unsubscribe = subscribe(assembly.session, (event) => {
      pushNotify(makeNotification("session/event", { sessionId: assembly.sessionId, event }) as RpcNotification)
    })
    assemblyUnsubscribes.set(assembly.sessionId, unsubscribe)
  })

  const statusNotify = (sessionId: string, status: string, error?: string): void => {
    pushNotify(makeNotification("session/status", { sessionId, status, ...(error !== undefined ? { error } : {}) }) as RpcNotification)
  }

  /** Make sure the session exists in the coordinator (create once per id). */
  async function ensureSession(sessionId: string): Promise<void> {
    if (opts.coordinator === undefined) return
    if (knownSessions.has(sessionId) || creatingSessions.has(sessionId)) return
    creatingSessions.add(sessionId)
    try {
      const known = (await opts.coordinator.list()).includes(sessionId)
      if (!known) await opts.coordinator.create({ sessionId })
      knownSessions.add(sessionId)
    } finally {
      creatingSessions.delete(sessionId)
    }
  }

  async function handleRequest(method: string, params: unknown, id: number | string): Promise<RpcMessage> {
    switch (method) {
      case "initialize": {
        return makeSuccess(id, {
          name: SDK_SERVER_NAME,
          version: opts.version ?? "0.1.0",
          protocolVersion: SDK_SERVER_PROTOCOL_VERSION,
          capabilities: {
            session: ["prompt", "status"],
            notifications: ["session/event", "session/status"],
          },
        })
      }
      case "session/status": {
        const p = params as { sessionId?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/status requires a non-empty sessionId")
        }
        return makeSuccess(id, service.queueState(p.sessionId))
      }
      case "session/prompt": {
        const p = params as { sessionId?: unknown; prompt?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/prompt requires a non-empty sessionId")
        }
        const prompt = typeof p.prompt === "string" ? p.prompt : ""
        if (prompt === "") {
          return makeFailure(id, INVALID_PARAMS, "session/prompt requires a non-empty prompt string")
        }
        const sessionId = p.sessionId
        try {
          await ensureSession(sessionId)
        } catch (error) {
          return makeFailure(id, INTERNAL_ERROR, "failed to prepare session", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        // lifecycle: submit chains behind an active turn → notify both states
        statusNotify(sessionId, "queued")
        inflight.set(sessionId, { prompt })
        const controller = new AbortController()
        try {
          await service.submit(sessionId, prompt, controller.signal)
          statusNotify(sessionId, "idle")
          return makeSuccess(id, { sessionId, ok: true })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          statusNotify(sessionId, "error", message)
          return makeFailure(id, INTERNAL_ERROR, message, {
            sessionId,
            events: liveEventsFor(service, sessionId),
          })
        } finally {
          inflight.delete(sessionId)
        }
      }
      case "shutdown": {
        // respond first, then let the host wind down (the response must never
        // race the process exit)
        const reply = makeSuccess(id, { ok: true })
        queueMicrotask(() => { opts.onShutdown?.() })
        return reply
      }
      default:
        return makeFailure(id, METHOD_NOT_FOUND, `unknown method: ${method}`)
    }
  }

  return {
    async handleLine(line): Promise<string | null> {
      if (closed) return null
      const message = decodeFrame(line)
      if (message === undefined) return null // malformed → ignored
      if (isRpcNotification(message)) return null // client → server notifications are accepted-and-ignored in v1
      if (!isRpcRequest(message)) return null
      const reply = await handleRequest(message.method, message.params, message.id)
      pushMessage(reply)
      return encodeFrame(reply)
    },
    onNotify(cb) {
      notifiers.add(cb)
      return () => { notifiers.delete(cb) }
    },
    async close() {
      if (closed) return
      closed = true
      offAssembly()
      for (const unsub of assemblyUnsubscribes.values()) unsub()
      assemblyUnsubscribes.clear()
    },
  }
}

/** The live session events for an error response (best effort; the submit
 * rejection may arrive before/after the assembly's events are visible). */
function liveEventsFor(service: SessionService, sessionId: string): SessionEvent[] {
  const live = service.liveSession(sessionId)
  return live?.events ?? []
}
