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
//   session/cancel {sessionId}   [M41b v1.1]
//                          → { cancelled, reason? } — aborts the in-flight
//                            submit's per-session AbortController
//   session/rewind/points {sessionId}            [M41b v1.1]
//   session/rewind/plan {sessionId, target, mode?}
//   session/rewind/execute {sessionId, target, mode?}
//                          → wire shapes documented in protocol.ts; driven by
//                            the injectable rewindFactory (absent →
//                            -32603 "rewind not enabled"); unknown session →
//                            -32602 "session not found" (never auto-creates)
//   shutdown               → { ok: true } (then onShutdown fires)
// Notifications (server → client):
//   session/event  { sessionId, event }   — every appended session event
//   session/status { sessionId, status, error? } — lifecycle transitions
// Malformed lines are ignored; unknown methods get -32601; invalid params -32602.
import { append, subscribe, type SessionEvent } from "@i-harness/core-session"
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
  type RewindPointsResponse,
  type RewindPlanResponse,
  type RewindExecuteResponse,
  type RewindMode,
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
  /** M41b v1.1: the rewind seam — a per-session resolve of the engine surface
   * (packages/rewind RewindService rebuilt over the live assembly's rewind
   * handle, embedded-bridge style). The host provides it; the server only
   * calls it per request (the factory resolves the CURRENT assembly fresh —
   * a host/store mismatch must never be cached). `undefined` return value →
   * the rewind methods answer -32603 "rewind not enabled". Absent option →
   * every rewind method answers "rewind not enabled" (honest capability
   * absence; the client gates on the "session-rewind" capability row). */
  rewindFactory?: (sessionId: string) => RewindServiceSurface | undefined
  /** Server info version payload (defaults to "0.1.0"). */
  version?: string
  /** Fired after a successful shutdown request. */
  onShutdown?: () => void
}

/** M41b v1.1: the host-side rewind surface the server invokes per request.
 * The shapes are the WIRE shapes (protocol.ts mirrors packages/rewind); the
 * host maps the engine's domain types onto them when implementing the factory
 * (the wire cannot depend on packages/rewind — independent). `appendEvent`
 * receives the engine's rewind/point conversation marker; the server appends
 * it into the LIVE session log (session/event flows to the client). */
export interface RewindServiceSurface {
  points(): Promise<RewindPointsResponse>
  plan(targetTurnIndex: number, mode: RewindMode): Promise<RewindPlanResponse>
  execute(
    targetTurnIndex: number,
    mode: RewindMode,
    hooks: { appendEvent: (event: unknown) => void },
  ): Promise<RewindExecuteResponse>
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
 * keep the notification stream ordered for the client). M41b v1.1: the
 * controller is the per-session cancel slot — session/prompt creates it
 * before submit, session/cancel aborts it, and the submit's own finally clears
 * it (only when the slot still holds THIS submit's controller — a staggered
 * second submit must not be clobbered early). */
interface Inflight {
  prompt: string
  controller: AbortController
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

  /** M41b v1.1: resolve the host's rewind surface per request, or null when
   * the seam is absent (never cached — the host may have (re)wired it). */
  const rewindSurfaceFor = (sessionId: string): RewindServiceSurface | null =>
    opts.rewindFactory === undefined ? null : opts.rewindFactory(sessionId) ?? null

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
        // M41a v1: protocolVersion 2; the capabilities object only GAINS rows
        // (the v0 rows are byte-identical — additive-only). M41b v1.1: four
        // more additive rows total ("session-history"/"session-list" + the
        // "session-cancel"/"session-rewind" appendix rows) — protocolVersion
        // STAYS 2; the v1.1 surface is capability-advertised.
        return makeSuccess(id, {
          name: SDK_SERVER_NAME,
          version: opts.version ?? "0.1.0",
          protocolVersion: SDK_SERVER_PROTOCOL_VERSION,
          capabilities: {
            session: ["prompt", "status"],
            notifications: ["session/event", "session/status"],
            "session-history": ["1"],
            "session-list": ["1"],
            "session-cancel": ["1"],
            "session-rewind": ["1"],
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
      case "session/cancel": {
        // M41b v1.1: abort the in-flight submit's controller (the same one the
        // session/prompt handler created and passed to service.submit). The
        // engine decides what an aborted signal does (a queued turn never
        // starts — service.submit checks signal.aborted); the server's answer
        // is the honest slot state: cancelled:true (aborted) / not-running
        // (known + idle) / not-found (never seen by this server). Unknown
        // sessions are answered inside the success payload — never an error
        // frame — because "nothing to cancel" is a legitimate client question.
        const p = params as { sessionId?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/cancel requires a non-empty sessionId")
        }
        const inFlight = inflight.get(p.sessionId)
        if (inFlight !== undefined) {
          inFlight.controller.abort()
          return makeSuccess(id, { cancelled: true })
        }
        const known = service.liveSession(p.sessionId) !== undefined || knownSessions.has(p.sessionId)
        return known
          ? makeSuccess(id, { cancelled: false, reason: "not-running" })
          : makeSuccess(id, { cancelled: false, reason: "not-found" })
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
      case "session/rewind/points": {
        // M41b v1.1: the rewind engine's durable-point list (host-wired
        // rewindFactory; the wire shapes mirror packages/rewind — documented
        // in protocol.ts). Fail-closed chain: live session required (never
        // auto-created), factory required ("rewind not enabled"), engine
        // errors surface with their raw message (-32603).
        const p = params as { sessionId?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/rewind/points requires a non-empty sessionId")
        }
        if (service.liveSession(p.sessionId) === undefined) {
          return makeFailure(id, INVALID_PARAMS, `session/rewind/points: session not found: ${p.sessionId}`)
        }
        const surface = rewindSurfaceFor(p.sessionId)
        if (surface === null) {
          return makeFailure(id, INTERNAL_ERROR, "session/rewind/points: rewind not enabled")
        }
        try {
          return makeSuccess(id, await surface.points())
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return makeFailure(id, INTERNAL_ERROR, `session/rewind/points: ${message}`)
        }
      }
      case "session/rewind/plan": {
        const p = params as { sessionId?: unknown; target?: unknown; mode?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/rewind/plan requires a non-empty sessionId")
        }
        const parsed = parseRewindTargetMode(p, "session/rewind/plan")
        if (!parsed.ok) return makeFailure(id, INVALID_PARAMS, parsed.message)
        if (service.liveSession(p.sessionId) === undefined) {
          return makeFailure(id, INVALID_PARAMS, `session/rewind/plan: session not found: ${p.sessionId}`)
        }
        const surface = rewindSurfaceFor(p.sessionId)
        if (surface === null) {
          return makeFailure(id, INTERNAL_ERROR, "session/rewind/plan: rewind not enabled")
        }
        try {
          return makeSuccess(id, await surface.plan(parsed.target, parsed.mode))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return makeFailure(id, INTERNAL_ERROR, `session/rewind/plan: ${message}`)
        }
      }
      case "session/rewind/execute": {
        // M41b v1.1: apply the rewind — the engine restores file ops + the
        // server appends the conversation marker (appendEvent) into the LIVE
        // session log, so the rewind/point event flows to the client on the
        // existing session/event stream (G2 owns the derived-view projection).
        const p = params as { sessionId?: unknown; target?: unknown; mode?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/rewind/execute requires a non-empty sessionId")
        }
        const parsed = parseRewindTargetMode(p, "session/rewind/execute")
        if (!parsed.ok) return makeFailure(id, INVALID_PARAMS, parsed.message)
        const live = service.liveSession(p.sessionId)
        if (live === undefined) {
          return makeFailure(id, INVALID_PARAMS, `session/rewind/execute: session not found: ${p.sessionId}`)
        }
        const surface = rewindSurfaceFor(p.sessionId)
        if (surface === null) {
          return makeFailure(id, INTERNAL_ERROR, "session/rewind/execute: rewind not enabled")
        }
        try {
          // The appendEvent closure binds the LIVE session (the same identity
          // session/prompt submits to — the marker's append target)).
          const result = await surface.execute(parsed.target, parsed.mode, {
            appendEvent: (event) => { append(live, event as SessionEvent) },
          })
          return makeSuccess(id, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return makeFailure(id, INTERNAL_ERROR, `session/rewind/execute: ${message}`)
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
        // M41b v1.1 — the per-session cancel slot: ONE controller per submit,
        // registered BEFORE service.submit (session/cancel aborts it), cleared
        // after. A staggered second submit overwrites the slot (its abort
        // becomes the cancel target — the queued turn is the one at risk); the
        // clear is conditional so an earlier submit's settle never unseats a
        // later in-flight one.
        const controller = new AbortController()
        statusNotify(sessionId, "queued")
        inflight.set(sessionId, { prompt, controller })
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
          if (inflight.get(sessionId)?.controller === controller) inflight.delete(sessionId)
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

/** M41b v1.1: validate the shared rewind target/mode params (mode defaults to
 * "all"; a non-integer negative target and any unknown mode are fail-closed
 * INVALID_PARAMS — the engine never sees them). */
function parseRewindTargetMode(
  p: { target?: unknown; mode?: unknown } | undefined,
  method: string,
): { ok: true; target: number; mode: RewindMode } | { ok: false; message: string } {
  const rawTarget = p?.target === undefined ? -1 : p.target
  if (typeof rawTarget !== "number" || !Number.isInteger(rawTarget) || rawTarget < 0) {
    return { ok: false, message: `${method} target must be a non-negative integer` }
  }
  const rawMode = p?.mode === undefined ? "all" : p.mode
  const mode = rawMode === "all" || rawMode === "files" || rawMode === "conversation" ? rawMode : undefined
  if (mode === undefined) {
    return { ok: false, message: `${method} mode must be one of all|files|conversation` }
  }
  return { ok: true, target: rawTarget, mode }
}
