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
//   session/history {sessionId, afterSeq?, limit?}  [M41a v1]
//                          → { events, nextSeq }; unknown session → -32602
//                            with an explicit "session not found" message
//   session/list {}        [M41a v1]
//                          → { sessions, listingUnavailable? } (injectable
//                            listSessions source; absent source → honest
//                            listingUnavailable: true)
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
  type SessionListResult,
} from "./protocol.ts"

export const SDK_SERVER_NAME = "i-harness"
export const SDK_SERVER_PROTOCOL_VERSION = PROTOCOL_VERSION

// M41a v1: session/history paging defaults (additive — v0 never had this).
const HISTORY_DEFAULT_LIMIT = 500
const HISTORY_LIMIT_CAP = 1000

export interface SdkServerOptions {
  /** Server → client writer (responses AND notifications both flow here when
   * provided; see also onNotify for notifications only). */
  onWrite?: (message: RpcMessage) => void
  /** Notification-only sink (session/event, session/status). */
  onNotify?: (message: RpcNotification) => void
  /** Session creation source — when given, session/prompt auto-creates an
   * unknown session before submit (durability requires the session to exist). */
  coordinator?: SessionCoordinator
  /** M41a v1: session/list source — the host's store listing (apps/cli: the
   * coordinator's list()+profile(), web-host mirror). When absent, session/list
   * answers `{ sessions: [], listingUnavailable: true }` (an honest blank —
   * "unknown" is never served as "empty"). */
  listSessions?: () => Promise<SessionListResult>
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

  /** One sink path for EVERY outgoing message: onWrite (the CLI's stdout
   * writer), then onNotify + subscription listeners for notifications. */
  const emitMessage = (message: RpcMessage): void => {
    opts.onWrite?.(message)
    if (isRpcNotification(message)) {
      opts.onNotify?.(message)
      for (const cb of [...notifiers]) cb(message)
    }
  }

  // Session event bridge: one subscription per live assembly — every appended
  // session/event flows to the client. Detached on close.
  const assemblyUnsubscribes = new Map<string, () => void>()
  const offAssembly = service.onAssembly((assembly) => {
    if (assembly.sessionId === undefined) return
    const unsubscribe = subscribe(assembly.session, (event) => {
      emitMessage(makeNotification("session/event", { sessionId: assembly.sessionId, event }))
    })
    assemblyUnsubscribes.set(assembly.sessionId, unsubscribe)
  })

  const statusNotify = (sessionId: string, status: string, error?: string): void => {
    emitMessage(makeNotification("session/status", { sessionId, status, ...(error !== undefined ? { error } : {}) }))
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
        // M41a v1: protocolVersion 2; the capabilities object only GAINS the
        // two rows below (the v0 rows are byte-identical — additive-only).
        return makeSuccess(id, {
          name: SDK_SERVER_NAME,
          version: opts.version ?? "0.1.0",
          protocolVersion: SDK_SERVER_PROTOCOL_VERSION,
          capabilities: {
            session: ["prompt", "status"],
            notifications: ["session/event", "session/status"],
            "session-history": ["1"],
            "session-list": ["1"],
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
      case "session/history": {
        // M41a v1: event-log walk over the LIVE in-process session (the
        // assembly's log is the session source — same identity as
        // session/prompt's submit target). Fail-closed: an unknown session is
        // NEVER auto-created by a read; it fails with an explicit message.
        const p = params as { sessionId?: unknown; afterSeq?: unknown; limit?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/history requires a non-empty sessionId")
        }
        const afterSeq = p.afterSeq === undefined ? 0 : p.afterSeq
        if (typeof afterSeq !== "number" || !Number.isInteger(afterSeq) || afterSeq < 0) {
          return makeFailure(id, INVALID_PARAMS, "session/history afterSeq must be a non-negative integer")
        }
        const rawLimit = p.limit === undefined ? HISTORY_DEFAULT_LIMIT : p.limit
        if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit <= 0) {
          return makeFailure(id, INVALID_PARAMS, "session/history limit must be a positive integer")
        }
        const limit = Math.min(rawLimit, HISTORY_LIMIT_CAP)
        const session = service.liveSession(p.sessionId)
        if (session === undefined) {
          return makeFailure(id, INVALID_PARAMS, `session/history: session not found: ${p.sessionId}`)
        }
        // The live log seqs are the 0-based positions in events (assigned at
        // append), so the walk is a slice: [afterSeq exclusive, nextSeq).
        const start = Math.min(afterSeq, session.events.length)
        const end = Math.min(start + limit, session.events.length)
        return makeSuccess(id, { events: session.events.slice(start, end), nextSeq: end })
      }
      case "session/list": {
        // M41a v1: the listing source is an INJECTABLE server option — the
        // server itself knows nothing about the store (the session source and
        // the listing source are both host concerns). Absent → an honest
        // "unavailable" flag, never a fabricated empty list.
        if (opts.listSessions === undefined) {
          return makeSuccess(id, { sessions: [], listingUnavailable: true })
        }
        try {
          return makeSuccess(id, await opts.listSessions())
        } catch (error) {
          // same convention as session/prompt's failure frame: the raw error
          // message rides in `message` (never a silent empty list)
          const message = error instanceof Error ? error.message : String(error)
          return makeFailure(id, INTERNAL_ERROR, message)
        }
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
      emitMessage(reply)
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
