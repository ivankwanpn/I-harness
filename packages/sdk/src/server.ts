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
//   session/queue {sessionId}    [M49 Task 11]
//                          → { items } — the real per-session queue projection
//                            (running row first, rest FIFO)
//   session/queue/cancel {sessionId, id} [M49 Task 11]
//                          → { cancelled } — one queued row, honest false for
//                            finished/running/unknown ids
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
import { append, subscribe, type Session, type SessionEvent } from "@i-harness/core-session"
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
  type SessionIdResult,
  type SessionModelSelection,
  type SessionModelState,
  type TaskCancelStatus,
  type DashboardSessionRow,
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
  /** Additive session lifecycle/model seams. Capability rows are advertised
   * only when the corresponding host operation is actually available. */
  createSession?: () => Promise<SessionIdResult>
  forkSession?: (sessionId: string) => Promise<SessionIdResult>
  modelState?: (sessionId: string) => Promise<SessionModelState>
  setSessionModel?: (sessionId: string, selection: SessionModelSelection) => Promise<void>
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
  const preparingSessions = new Map<string, Promise<boolean>>()
  const preparingHistorySessions = new Map<string, Promise<Session | undefined>>()
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

  /** Verify/adopt a durable session, optionally creating it for write paths.
   * The per-id promise is shared by prompt and history racers. If a read-only
   * check finds no session, a concurrent prompt retries in create mode after
   * that check settles; history itself never crosses the creation boundary. */
  async function prepareSession(sessionId: string, createIfMissing: boolean): Promise<boolean> {
    if (opts.coordinator === undefined) return createIfMissing
    if (knownSessions.has(sessionId)) return true

    for (;;) {
      const pending = preparingSessions.get(sessionId)
      if (pending !== undefined) {
        const prepared = await pending
        if (prepared || !createIfMissing) return prepared
        if (preparingSessions.get(sessionId) === pending) preparingSessions.delete(sessionId)
        continue
      }

      const preparation = (async () => {
        const known = (await opts.coordinator!.list()).includes(sessionId)
        if (known) {
          // Existing durable sessions are resumed by this server, so keep the
          // ownership lease for the lifetime of the coordinator.
          await opts.coordinator!.adoptOwnership(sessionId)
        } else if (createIfMissing) {
          // create() acquires ownership for a newly opened durable session.
          await opts.coordinator!.create({ sessionId })
        } else {
          return false
        }
        knownSessions.add(sessionId)
        return true
      })()
      preparingSessions.set(sessionId, preparation)
      try {
        const prepared = await preparation
        if (prepared || !createIfMissing) return prepared
      } finally {
        if (preparingSessions.get(sessionId) === preparation) preparingSessions.delete(sessionId)
      }
    }
  }

  /** Make sure a prompt target exists and is owned in the coordinator. */
  async function ensureSession(sessionId: string): Promise<void> {
    await prepareSession(sessionId, true)
  }

  async function sessionForHistory(sessionId: string): Promise<Session | undefined> {
    const live = service.liveSession(sessionId)
    if (live !== undefined) return live
    const existing = preparingHistorySessions.get(sessionId)
    if (existing !== undefined) return existing

    const knownBefore = knownSessions.has(sessionId)
    const ownedBefore = opts.coordinator?.ownerOf?.(sessionId) ?? false
    let preparation!: Promise<Session | undefined>
    preparation = (async () => {
      try {
        if (!(await prepareSession(sessionId, false))) return undefined
        return (await service.assemblyFor(sessionId)).session
      } catch (error) {
        if (!knownBefore) {
          knownSessions.delete(sessionId)
          if (!ownedBefore && opts.coordinator !== undefined) {
            await opts.coordinator.releaseOwnership(sessionId).catch(() => {})
          }
        }
        throw error
      }
    })().finally(() => {
      if (preparingHistorySessions.get(sessionId) === preparation) preparingHistorySessions.delete(sessionId)
    })
    preparingHistorySessions.set(sessionId, preparation)
    return preparation
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
            // M49 Task 11: the queue projection comes from the SessionService
            // itself (never a host seam) — the row is unconditional.
            "session-rewind": ["1"],
            "session-queue": ["1"],
            // M49 Task 12: the task projection + cancellation (same service,
            // Serialize-only rows) — unconditional too.
            "session-tasks": ["1"],
            // M49 Task 13: the local dashboard projection (spec §8.3) — the
            // service's own per-session live/queue/task/model values over the
            // listing source; no host seam needed.
            "session-dashboard": ["1"],
            ...(opts.createSession !== undefined ? { "session-create": ["1"] } : {}),
            ...(opts.forkSession !== undefined ? { "session-fork": ["1"] } : {}),
            ...(opts.modelState !== undefined && opts.setSessionModel !== undefined
              ? { "session-model": ["1"] }
              : {}),
          },
        })
      }
      case "session/create": {
        if (opts.createSession === undefined) {
          return makeFailure(id, METHOD_NOT_FOUND, "session/create unavailable")
        }
        try {
          const result = validSessionIdResult(await opts.createSession(), "session/create")
          knownSessions.add(result.sessionId)
          return makeSuccess(id, result)
        } catch (error) {
          return hostMethodFailure(id, "session/create", error)
        }
      }
      case "session/fork": {
        if (opts.forkSession === undefined) {
          return makeFailure(id, METHOD_NOT_FOUND, "session/fork unavailable")
        }
        const p = params as { sessionId?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/fork requires a non-empty sessionId")
        }
        try {
          const result = validSessionIdResult(await opts.forkSession(p.sessionId), "session/fork")
          knownSessions.add(result.sessionId)
          return makeSuccess(id, result)
        } catch (error) {
          return hostMethodFailure(id, "session/fork", error)
        }
      }
      case "session/model/state": {
        if (opts.modelState === undefined) {
          return makeFailure(id, METHOD_NOT_FOUND, "session/model/state unavailable")
        }
        const p = params as { sessionId?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/model/state requires a non-empty sessionId")
        }
        try {
          return makeSuccess(id, serializeModelState(await opts.modelState(p.sessionId)))
        } catch (error) {
          return hostMethodFailure(id, "session/model/state", error)
        }
      }
      case "session/model/set": {
        if (opts.modelState === undefined || opts.setSessionModel === undefined) {
          return makeFailure(id, METHOD_NOT_FOUND, "session/model/set unavailable")
        }
        const p = params as { sessionId?: unknown; selection?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/model/set requires a non-empty sessionId")
        }
        const selection = parseModelSelection(p.selection)
        if (selection === undefined) {
          return makeFailure(id, INVALID_PARAMS, "session/model/set requires non-empty provider and model")
        }
        const queue = service.queueState(p.sessionId)
        if (queue.running || queue.queued > 0) {
          return makeFailure(id, INTERNAL_ERROR, `session/model/set: session busy: ${p.sessionId}`)
        }
        try {
          await opts.setSessionModel(p.sessionId, selection)
          await service.closeSession(p.sessionId)
          return makeSuccess(id, serializeModelState(await opts.modelState(p.sessionId)))
        } catch (error) {
          return hostMethodFailure(id, "session/model/set", error)
        }
      }
      case "session/status": {
        // Count-only compatibility surface (M49 Task 11 keeps it rowless).
        const p = params as { sessionId?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/status requires a non-empty sessionId")
        }
        return makeSuccess(id, service.queueState(p.sessionId))
      }
      case "session/queue": {
        // M49 Task 11: the REAL projection — the running row is first, the
        // rest FIFO; the id emits serially-executed rows with their public
        // ids (service-front + lane merged; never fabricated).
        const p = params as { sessionId?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/queue requires a non-empty sessionId")
        }
        return makeSuccess(id, { items: service.queue(p.sessionId) })
      }
      case "session/queue/cancel": {
        const p = params as { sessionId?: unknown; id?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/queue/cancel requires a non-empty sessionId")
        }
        if (typeof p?.id !== "string" || p.id === "") {
          return makeFailure(id, INVALID_PARAMS, "session/queue/cancel requires a non-empty id")
        }
        // Honest answer inside the success payload — a finished/unknown id is
        // a legitimate client question, never an error frame.
        return makeSuccess(id, service.cancelQueued(p.sessionId, p.id))
      }
      case "session/tasks": {
        // M49 Task 12: the REAL per-session task projection — serialized
        // summary rows only (never a registry object); an unknown-but-valid
        // session answers an honest empty list.
        const p = params as { sessionId?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/tasks requires a non-empty sessionId")
        }
        return makeSuccess(id, { items: service.tasks(p.sessionId) })
      }
      case "session/tasks/cancel": {
        const p = params as { sessionId?: unknown; id?: unknown } | undefined
        if (typeof p?.sessionId !== "string" || p.sessionId === "") {
          return makeFailure(id, INVALID_PARAMS, "session/tasks/cancel requires a non-empty sessionId")
        }
        if (typeof p?.id !== "string" || p.id === "") {
          return makeFailure(id, INVALID_PARAMS, "session/tasks/cancel requires a non-empty id")
        }
        try {
          const status: TaskCancelStatus = service.cancelTask(p.sessionId, p.id)
          return makeSuccess(id, { status })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // Unknown ids keep the existing not-found semantics (the owning
          // registry's explicit "unknown job/task" error — never a fabricated
          // "already-finished").
          return /unknown (?:job|task)/i.test(message)
            ? makeFailure(id, INVALID_PARAMS, `session/tasks/cancel: ${message}`)
            : hostMethodFailure(id, "session/tasks/cancel", error)
        }
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
        // M41a v1: event-log walk over the in-process assembly. A cold durable
        // session is verified/adopted through the coordinator and assembled
        // on demand; an unknown id is NEVER auto-created by this read.
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
        let session: Session | undefined
        try {
          session = await sessionForHistory(p.sessionId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return makeFailure(id, INTERNAL_ERROR, `session/history: failed to prepare session: ${message}`)
        }
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
      case "session/dashboard": {
        // M49 Task 13 (spec §8.3): the LOCAL dashboard projection — the
        // listing rows enriched with KNOWN live fields (the service's own
        // truth per session). Absent listing source → the honest
        // listingUnavailable blank (never rows the server did not provide).
        // The wire shape has NO cost/team member — serializable only.
        if (opts.listSessions === undefined) {
          return makeSuccess(id, { sessions: [], listingUnavailable: true })
        }
        try {
          const listed = await opts.listSessions()
          const sessions: DashboardSessionRow[] = []
          for (const row of listed.sessions) {
            const live = service.hasAssembly(row.id)
            const out: DashboardSessionRow = {
              id: row.id,
              ...(typeof row.title === "string" ? { title: row.title } : {}),
              ...(typeof row.updatedAt === "number" ? { updatedAt: row.updatedAt } : {}),
              ...(typeof row.turnCount === "number" ? { turnCount: row.turnCount } : {}),
              ...(typeof row.contextUsed === "number" ? { contextUsed: row.contextUsed } : {}),
              ...(typeof row.contextTotal === "number" ? { contextTotal: row.contextTotal } : {}),
              live,
            }
            if (live) {
              const queue = service.queueState(row.id)
              out.running = queue.running
              if (queue.queued > 0) out.queued = queue.queued
              const liveTasks = service.tasks(row.id)
                .filter((task) => task.status === "queued" || task.status === "running" || task.status === "waiting")
                .length
              if (liveTasks > 0) out.tasks = liveTasks
              try {
                const model = await service.modelState(row.id)
                if (model.status === "ready" && model.label !== "") {
                  out.modelLabel = model.label
                }
              } catch {
                // model resolution failed — the field stays absent (never fabricated)
              }
            }
            sessions.push(out)
          }
          return makeSuccess(id, { sessions })
        } catch (error) {
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

function validSessionIdResult(result: SessionIdResult, method: string): SessionIdResult {
  if (typeof result?.sessionId !== "string" || result.sessionId === "") {
    throw new Error(`${method}: host returned an invalid sessionId`)
  }
  return { sessionId: result.sessionId }
}

function parseModelSelection(value: unknown): SessionModelSelection | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof raw.provider !== "string" || raw.provider.trim() === ""
    || typeof raw.model !== "string" || raw.model.trim() === "") {
    return undefined
  }
  if (raw.reasoningEffort !== undefined
    && (typeof raw.reasoningEffort !== "string" || raw.reasoningEffort.trim() === "")) {
    return undefined
  }
  return {
    provider: raw.provider.trim(),
    model: raw.model.trim(),
    ...(typeof raw.reasoningEffort === "string"
      ? { reasoningEffort: raw.reasoningEffort.trim() }
      : {}),
  }
}

function serializeModelState(state: SessionModelState): SessionModelState {
  if (state.status === "unconfigured") {
    if (typeof state.reason !== "string") throw new Error("invalid unconfigured model state")
    return { status: "unconfigured", reason: state.reason }
  }
  if (state.status === "invalid") {
    if (typeof state.reason !== "string") throw new Error("invalid model state")
    return {
      status: "invalid",
      reason: state.reason,
      ...(typeof state.providerId === "string" ? { providerId: state.providerId } : {}),
      ...(typeof state.modelId === "string" ? { modelId: state.modelId } : {}),
    }
  }
  if (state.status === "ready"
    && typeof state.providerId === "string" && state.providerId !== ""
    && typeof state.modelId === "string" && state.modelId !== ""
    && typeof state.label === "string" && state.label !== "") {
    return {
      status: "ready",
      providerId: state.providerId,
      modelId: state.modelId,
      label: state.label,
    }
  }
  throw new Error("invalid ready model state")
}

function hostMethodFailure(id: number | string, method: string, error: unknown): RpcMessage {
  const message = error instanceof Error ? error.message : String(error)
  return isSessionNotFoundError(message)
    ? makeFailure(id, INVALID_PARAMS, `${method}: ${message}`)
    : makeFailure(id, INTERNAL_ERROR, `${method}: ${message}`)
}

function isSessionNotFoundError(message: string): boolean {
  return /(?:unknown session|session not found)/i.test(message)
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
