// @i-harness/tui G2 (M38b/M41a) — REMOTE backend: a BackendClient over the
// @i-harness/sdk JSON-RPC wire (v0 FROZEN — the field-level lock lives in
// packages/sdk/test/server.test.ts "initialize wire contract v0"; M41a adds
// the v1 methods session/history + session/list per the versioning rules:
// v1 may ONLY add — the v0 surface stays untouched). This is the
// `--attach <sessionId>` path: the host spawns an `i-harness sdk` stdio
// subprocess (apps/cli), the TUI drives a remote session over it.
//
// Wire surface used here (client → server):
//   initialize {}                         → { name, version, protocolVersion,
//                                           capabilities } — the version
//                                           handshake: THE m41a capability
//                                           detection. The backend captures
//                                           protocolVersion itself (once,
//                                           cached); < 2 → the v0 degrade
//                                           paths below.
//   session/prompt { sessionId, prompt }   → { sessionId, ok: true }; the
//                                           response resolves AFTER the turn
//                                           DRAINS; a failed turn is a -32603
//                                           error (data.events = the live
//                                           collected events)
//   session/status { sessionId }           → { running, queued }
//   session/history { sessionId, afterSeq?, limit? }   → { events, nextSeq }
//                                           (wire v1: the durable log walk —
//                                           the M38b replay gap, CLOSED)
//   session/list {}                       → { sessions: [...],
//                                           listingUnavailable? } (wire v1:
//                                           the M38b list gap, CLOSED;
//                                           listingUnavailable: true — and the
//                                           design-spec's status "listing-
//                                           unavailable" marker, accepted too —
//                                           = the server has no listing
//                                           source → the client returns []
//                                           honestly; entry fields beyond id
//                                           (title/updatedAt/turnCount) are
//                                           OPTIONAL per the v1 wire — the
//                                           client fills honest defaults)
//   shutdown                               → { ok: true } (host teardown)
// Notifications (server → client):
//   session/event  { sessionId, event }    — the APPEND-ONLY event stream
//                                           (live only; historical events
//                                           come back via session/history on
//                                           a v1 server)
//   session/status { sessionId, status }   — lifecycle transitions (queued /
//                                           idle / error)
//
// Event mapping REUSE: the TuiEvents are produced by the exact same mapper
// the embedded bridge uses — `mapSessionEvent` + `EventMapState` are exported
// from ./embedded.ts and consumed verbatim here, so live remote runs and
// embedded runs produce byte-identical TuiEvents for identical logs.
//
// The client seam is STRUCTURAL (SdkClientLike): a host can plug the real
// @i-harness/sdk HarnessClient (same method/notification names — an exact
// structural match) or the in-package stdio client below
// (spawnSdkSubprocess). @i-harness/sdk is deliberately NOT a dependency of
// packages/tui (milestone constraint: no new private deps + package.json is
// untouchable while G1 lands marks/marked) — hosts with the real client wire
// it themselves; the wire names are the contract.
//
// LOUD GAPS (each documented honestly; 3/4 are CLOSED on wire v1 and degrade
// to the v0 behavior on an old server — the dual path is at the member):
//   1. cancel — v0 has NO cancel RPC (every session/prompt owns an internal
//      AbortController; the client has no handle to it). cancel() no-ops and
//      pushes ONE system note into the stream so the UI stays honest.
//   2. steer — v0 exposes only the send tier (session/prompt). A steer during
//      a running turn CHAINS behind it (the executor lane); when idle it
//      degrades to submit — the SAME behavior as the embedded bridge's idle
//      path (embedded.ts module header item 3).
//   3. replay — CLOSED on v1: session/history (handshake ≥ 2). On an OLD or
//      errant server (protocolVersion < 2 — the initialize handshake) the
//      append-only v0 rule still applies: replay(afterSeq) is [] and the TUI
//      starts at the attach moment. A v1 history call failure also degrades
//      to [] + a debug note (never fake events).
//   4. listSessions — CLOSED on v1: session/list (handshake ≥ 2). v0/present
//      degrade: the ACTIVE session only (stub row — contract-allowed), and a
//      v1 server without a listing source answers with the unavailability
//      marker (committed wire: `listingUnavailable: true`; design-spec's
//      status "listing-unavailable" is accepted too) → the client returns []
//      (honest empty; no fabricated rows).
//   5. context — no per-session metrics RPC in v0: the OPTIONAL
//      BackendClient.context() member is absent (the loop renders only what
//      exists — the chip is hidden, never estimated).
//   6. model label — the session's meta (modelSelection) is server-side and
//      v0 has no session/meta RPC: modelLabel exists only when the HOST knows
//      it (the -‑model spec it passed to the spawn).
import type { Readable, Writable } from "node:stream"
import { createInterface, type Interface } from "node:readline"
import { spawn, type ChildProcess } from "node:child_process"
import type { SessionEvent } from "@i-harness/core-session"
import { createEventMapState, mapSessionEvent, type EventMapState } from "./embedded.ts"
import type { BackendClient, SessionSummary, TuiEvent } from "../contracts.ts"

// ------------------------------------------------------------------ wire seam

/** One server → client notification (session/event, session/status). */
export interface SdkNotification {
  method: string
  params?: unknown
}

/** session/history result (wire v1): the durable SessionEvent log walk. */
export interface HistoryResult {
  events: SessionEvent[]
  /** The server's suggested next cursor (kept as emitted; the backend tracks
   * its own cursor from the mapped events — same as the embedded bridge). */
  nextSeq: number
}

/** session/list result (wire v1, NORMALIZED for the TUI): the row fields are
 * the SessionSummary's required ones (title "Session" / updatedAt 0 /
 * turnCount 0 fallbacks when the wire row carries only the id — the v1 wire's
 * entry fields beyond id are OPTIONAL per the contract; context fields parse
 * only when present), and the unavailability markers normalized to one flag:
 * `listingUnavailable: true` (the committed v1 shape) OR the design-spec's
 * `status: "listing-unavailable"` are both accepted on the wire. */
export interface SessionListResult {
  sessions: SessionSummary[]
  /** true when the server has no listing source (normalized marker) — the
   * client must NOT present [] as "the store is empty". */
  listingUnavailable?: true
}

/** Structural subset of @i-harness/sdk HarnessClient — the wire methods the
 * remote backend uses. A real HarnessClient satisfies this exactly. The seam
 * stays the WIRE METHODS (request()): the backend speaks session/history and
 * session/list by their wire names directly (a v0-era client on an old server
 * is gated by the version probe; the typed history()/listSessions() request
 * helpers live on the concrete stdio mirror below for hosts' convenience). */
export interface SdkClientLike {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
  /** Server → client notifications (session/event, session/status). */
  onNotification(listener: (notification: SdkNotification) => void): () => void
  /** Graceful close (shutdown + stream end); idempotent. */
  close(): Promise<void>
}

const REQUEST_TIMEOUT_MS = 60_000
/** session/prompt resolves only when the turn DRAINED (server semantics) — a
 * long model turn is NOT a timeout; this is a hang guard (30 min), not a turn
 * budget. Live events stream meanwhile regardless. */
const SUBMIT_TIMEOUT_MS = 30 * 60_000

/** The server's error RESPONSE (JSON-RPC error object). */
export class SdkWireError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "SdkWireError"
    this.code = code
    this.data = data
  }
}

// -------------------------------------------------- v1 response parsing
//
// Both wire consumers (the stdio mirror's typed helpers AND the backend's raw
// request() calls) run these parsers so a v1 response is validated
// identically no matter which path produced it. Malformed shapes are an
// SdkWireError (-32603-style internal) — NEVER a fabricated result; callers
// degrade.

/** Validate one session/history result (wire v1). */
function parseHistoryResult(result: unknown): HistoryResult {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/history response: result is not an object")
  }
  const r = result as { events?: unknown; nextSeq?: unknown }
  if (!Array.isArray(r.events)) {
    throw new SdkWireError(-32603, "malformed session/history response: events is not an array")
  }
  return {
    events: r.events as SessionEvent[],
    nextSeq: typeof r.nextSeq === "number" ? r.nextSeq : -1,
  }
}

/** Validate one session/list result (wire v1) and NORMALIZE it. Both the
 * committed v1 marker (`listingUnavailable: true`) and the design-spec's
 * `status: "listing-unavailable"` are accepted; a missing/insane `sessions`
 * array is the unavailability shape too — never a fabricated set. Entry
 * fields beyond id are OPTIONAL on the v1 wire (a header-only listing source
 * serves `{ id }`): the SessionSummary's required fields get honest defaults
 * (title "Session" = unknown, updatedAt 0 = unknown, turnCount 0), and
 * contextUsed/contextTotal are copied only when present (never a zero). */
function parseListResult(result: unknown): SessionListResult {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/list response: result is not an object")
  }
  const r = result as { sessions?: unknown; status?: unknown; listingUnavailable?: unknown }
  const unavailable =
    r.listingUnavailable === true || r.status === "listing-unavailable"
  if (!Array.isArray(r.sessions)) {
    // e.g. { listingUnavailable: true } without a sessions array
    return { sessions: [], ...(unavailable ? { listingUnavailable: true } : {}) }
  }
  const sessions: SessionSummary[] = []
  for (const raw of r.sessions) {
    if (raw === null || typeof raw !== "object") continue
    const e = raw as Record<string, unknown>
    if (typeof e.id !== "string" || e.id === "") continue
    sessions.push({
      id: e.id,
      title: typeof e.title === "string" && e.title !== "" ? e.title : "Session",
      updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : 0,
      turnCount: typeof e.turnCount === "number" ? e.turnCount : 0,
      ...(typeof e.contextUsed === "number" ? { contextUsed: e.contextUsed } : {}),
      ...(typeof e.contextTotal === "number" ? { contextTotal: e.contextTotal } : {}),
    })
  }
  return { sessions, ...(unavailable ? { listingUnavailable: true } : {}) }
}

// ------------------------------------------------- subprocess wire client

/** One in-flight request. */
interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

function decodeLine(line: string): unknown {
  if (line === "" || line.trim() === "") return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** A minimal NDJSON JSON-RPC 2.0 client over a spawned `i-harness sdk`
 * subprocess — mirrors @i-harness/sdk HarnessClient.spawn's shape (command/
 * args/cwd/env + child lifecycle hardening, 60 s request cap) WITHOUT
 * importing the package (module header: @i-harness/sdk must stay a non-dep).
 * Malformed lines are ignored (framing contract); request ids echo into
 * responses. */
export function spawnSdkSubprocess(opts: {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}): SdkClientLike {
  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  })
  return new SdkStdioClient(child.stdout, child.stdin, child)
}

class SdkStdioClient implements SdkClientLike {
  private readonly output: Writable
  private readonly rl: Interface
  private readonly child: ChildProcess
  private nextId = 1
  private closed = false
  private readonly pending = new Map<string, PendingRpc>()
  private readonly listeners = new Set<(n: SdkNotification) => void>()

  constructor(input: Readable, output: Writable, child: ChildProcess) {
    this.output = output
    this.child = child
    this.rl = createInterface({ input })
    this.rl.on("line", (line) => this.onLine(line))
    child.once("error", (error) => {
      const e = new Error(`sdk subprocess error: ${error.message}`)
      this.rejectAll(e)
    })
    child.once("exit", (code, signal) => {
      const e = new Error(`sdk subprocess exited (code ${code ?? "null"}, signal ${signal ?? "null"})`)
      this.rejectAll(e)
    })
  }

  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("sdk client is closed"))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.output.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n",
      )
    })
  }

  onNotification(listener: (notification: SdkNotification) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.output.write(JSON.stringify({ jsonrpc: "2.0", method: "shutdown" }) + "\n")
    } catch { /* best-effort */ }
    try {
      this.output.end()
    } catch { /* already ended */ }
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => this.child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ])
    if (!exited) this.child.kill()
    this.rl.close()
  }

  /** Wire v1: session/history — the mirror's typed request helper. The
   * request/response matching is the existing per-request-id path inside
   * request() (the pending map); this only shapes the call + validates the
   * result shape (parseHistoryResult). An old v0 server answers -32601 →
   * the helper rejects with SdkWireError (callers degrade). */
  async history(sessionId: string, afterSeq?: number, limit?: number): Promise<HistoryResult> {
    const result = await this.request(
      "session/history",
      { sessionId, ...(afterSeq !== undefined ? { afterSeq } : {}), ...(limit !== undefined ? { limit } : {}) },
      REQUEST_TIMEOUT_MS,
    )
    return parseHistoryResult(result)
  }

  /** Wire v1: session/list — the mirror's typed request helper (response
   * matching per-request-id as in request(); result validated). */
  async listSessions(): Promise<SessionListResult> {
    return parseListResult(await this.request("session/list", {}, REQUEST_TIMEOUT_MS))
  }

  private onLine(line: string): void {
    const decoded = decodeLine(line)
    if (decoded === null || typeof decoded !== "object") return
    const msg = decoded as Record<string, unknown>
    if (msg["jsonrpc"] !== "2.0") return
    if (typeof msg["id"] === "number" || typeof msg["id"] === "string") {
      const pending = this.pending.get(String(msg["id"]))
      if (pending === undefined) return
      this.pending.delete(String(msg["id"]))
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      if ("error" in msg) {
        const err = msg["error"] as { code?: unknown; message?: unknown; data?: unknown } | undefined
        pending.reject(new SdkWireError(
          typeof err?.code === "number" ? err.code : -32603,
          typeof err?.message === "string" ? err.message : "sdk error",
          err?.data,
        ))
      } else {
        pending.resolve(msg["result"])
      }
      return
    }
    if (typeof msg["method"] === "string") {
      const n: SdkNotification = { method: msg["method"], params: msg["params"] }
      for (const listener of [...this.listeners]) listener(n)
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, p] of this.pending) {
      if (p.timer !== undefined) clearTimeout(p.timer)
      p.reject(error)
      this.pending.delete(id)
    }
  }
}

// ------------------------------------------------------------------ backend

export interface RemoteBackendOptions {
  /** The wire client (already connected to an `i-harness sdk` stdio server). */
  client: SdkClientLike
  /** Initial session id (the --attach argument); open() may select others. */
  sessionId: string
  /** Session-picker/title fallback (default "Session"). */
  title?: string
  /** Info-line label — host-known only (--model spec); see LOUD gap 6. */
  modelLabel?: string
  /** Stream batching window in ms. Default 16 (§3.5). */
  batchMs?: number
}

/** A BackendClient over the SDK wire. See the module header for the exact
 * method/notification surface and the LOUD gaps (cancel/replay/list/context
 * are v0-constrained on purpose). */
export function createRemoteBackend(opts: RemoteBackendOptions): BackendClient {
  const batchMs = opts.batchMs ?? 16
  const liveState: EventMapState = createEventMapState()
  let sessionId = opts.sessionId
  let cursor = -1
  let turnCount = 0
  let cancelNoted = false
  let closed = false
  // Sync status cache: session/status NOTIFICATIONS update the lifecycle bits
  // between turns; every resolved submit refreshes the exact numbers via the
  // session/status REQUEST. In-band-first (the 16 ms stream keeps the app
  // painted while a turn runs).
  let lastStatus = { running: false, queued: 0 }

  // 16 ms batch queue — the same contract as the embedded bridge
  const queue: { items: TuiEvent[]; timer: NodeJS.Timeout | undefined; wake: (() => void) | undefined } = {
    items: [],
    timer: undefined,
    wake: undefined,
  }

  function pushEvent(ev: TuiEvent): void {
    queue.items.push(ev)
    cursor = Math.max(cursor, ev.seq)
    if (queue.timer === undefined) {
      queue.timer = setTimeout(() => {
        queue.timer = undefined
        queue.wake?.()
      }, batchMs)
      queue.timer.unref()
    }
  }

  function pushError(text: string): void {
    // Stream-only (never on the wire): synthetic seq = cursor+1.
    pushEvent({ type: "system", text, seq: cursor + 1, ts: Date.now() })
  }

  async function refreshStatus(): Promise<void> {
    try {
      const state = await opts.client.request("session/status", { sessionId }, REQUEST_TIMEOUT_MS)
      if (state !== null && typeof state === "object") {
        const s = state as { running?: unknown; queued?: unknown }
        lastStatus = { running: s.running === true, queued: typeof s.queued === "number" ? s.queued : 0 }
      }
    } catch {
      // best-effort: the notification cache still holds a real value
    }
  }

  // ---- M41a capability detection: the initialize handshake's
  // protocolVersion, captured on first wire need and cached. < 2 (an OLD
  // server — wire v0) → the honest dual path: replay [] and the
  // active-session list stub, exactly as before the v1 methods existed.
  let wireVersion: number | undefined

  async function probeVersion(): Promise<number> {
    if (wireVersion !== undefined) return wireVersion
    let version = 1
    try {
      const info = (await opts.client.request("initialize", {}, REQUEST_TIMEOUT_MS)) as { protocolVersion?: unknown } | null
      version = typeof info?.protocolVersion === "number" ? info.protocolVersion : 1
    } catch {
      // a server that cannot complete initialize is treated as v0 — the
      // safest degrade (no new-method calls; the stub row stays honest)
    }
    wireVersion = version
    return version
  }

  /** Wire v1 history — the raw wire method (the seam contract = the wire
   * names; a host's real client — typed helpers of any shape or none — always
   * speaks the same names through request()). */
  async function wireHistory(afterSeq: number, limit?: number): Promise<HistoryResult> {
    const result = await opts.client.request(
      "session/history",
      { sessionId, afterSeq, ...(limit !== undefined ? { limit } : {}) },
      REQUEST_TIMEOUT_MS,
    )
    return parseHistoryResult(result)
  }

  /** Wire v1 list — the raw wire method (same seam reasoning). */
  async function wireList(): Promise<SessionListResult> {
    const result = await opts.client.request("session/list", {}, REQUEST_TIMEOUT_MS)
    return parseListResult(result)
  }

  async function submit(prompt: string): Promise<void> {
    if (closed) throw new Error("remote backend closed")
    try {
      await opts.client.request("session/prompt", { sessionId, prompt }, SUBMIT_TIMEOUT_MS)
    } catch (error) {
      // -32603 with data.events = the collected turn events — the SAME events
      // already streamed to the UI via the live session/event notifications
      // (the subscription predates the submit), so the UI is up-to-date; the
      // error is rethrown for the loop's failure toast. Anything else (server
      // dead/timeout) also rethrows — surfaced by the loop.
      void error
      throw error
    } finally {
      void refreshStatus()
    }
  }

  async function steer(text: string): Promise<void> {
    // LOUD gap 2: the wire has only the send tier — chained-turn steering.
    await submit(text)
  }

  async function cancel(): Promise<void> {
    // LOUD gap 1: no cancel RPC — surface one honest note, never silent.
    if (cancelNoted) return
    cancelNoted = true
    pushError("cancel unavailable over --attach (sdk wire v0: no cancel RPC)")
  }

  async function *events(): AsyncIterable<TuiEvent> {
    for (;;) {
      if (queue.timer === undefined && queue.items.length > 0) {
        yield queue.items.shift()!
        continue
      }
      if (closed) break
      await new Promise<void>((resolve) => {
        queue.wake = resolve
      })
    }
    // close() flush — remaining items, no timer wait
    while (queue.items.length > 0) yield queue.items.shift()!
  }

  // Notification wiring: session/event → map → 16 ms batch (same
  // mapSessionEvent the embedded bridge uses — byte-identical mapping);
  // session/status → sync status cache. Events arriving before the loop starts
  // iterating buffer in the queue and are drained in arrival order.
  const off = opts.client.onNotification((n) => {
    if (n.method === "session/event" && n.params !== undefined) {
      const params = n.params as { sessionId?: unknown; event?: unknown } | undefined
      if (params?.sessionId !== sessionId || params.event === undefined) return
      const mapped = mapSessionEvent(params.event as SessionEvent, liveState)
      if (mapped === undefined) return
      if (mapped.type === "turn" && mapped.phase === "start") turnCount++
      pushEvent(mapped)
      return
    }
    if (n.method === "session/status" && n.params !== undefined) {
      const params = n.params as { sessionId?: unknown; status?: unknown } | undefined
      if (params?.sessionId !== sessionId || typeof params.status !== "string") return
      lastStatus = params.status === "queued"
        ? { ...lastStatus, running: true }
        : { ...lastStatus, running: false }
    }
  })

  return {
    async listSessions(): Promise<SessionSummary[]> {
      // Wire v1 (handshake ≥ 2): session/list — the server's real listing.
      // The server has no listing source → listingUnavailable (the committed
      // v1 marker; the design-spec's status marker is normalized too) → []
      // (HONEST empty — never a row the server did not provide).
      if ((await probeVersion()) >= 2) {
        try {
          const result = await wireList()
          if (result.listingUnavailable === true) {
            return []
          }
          return result.sessions
        } catch (error) {
          // honest degrade: [] + a debug note (a dead/errant server must not
          // produce fabricated rows)
          console.debug(`[remote] listSessions: wire session/list failed — ${error instanceof Error ? error.message : String(error)}`)
          return []
        }
      }
      // v0 degrade (protocolVersion < 2): no session/list RPC — the ACTIVE
      // session only (contract-allowed stub row), exactly as before.
      return [{ id: sessionId, title: opts.title ?? "Session", updatedAt: Date.now(), turnCount }]
    },

    async open(id: string): Promise<void> {
      if (closed) throw new Error("remote backend closed")
      sessionId = id
      cursor = -1
      liveState.lastSeq = -1
      liveState.chunksSinceAssistant = false
    },

    submit,
    steer,
    cancel,

    async *events() {
      yield* events()
    },

    seqCursor: () => cursor,

    async replay(afterSeq: number): Promise<TuiEvent[]> {
      // Wire v1 (handshake ≥ 2): session/history — the durable log walk,
      // mapped by the SAME shared mapper the embedded bridge and the live
      // notification path use (byte-identical mapping; the determinism
      // anchor), with a fresh map state over the whole walk so the
      // assistant-chunk dedupe sees every step.
      if ((await probeVersion()) >= 2) {
        try {
          const { events } = await wireHistory(afterSeq)
          const state = createEventMapState()
          const out: TuiEvent[] = []
          for (const ev of events) {
            const mapped = mapSessionEvent(ev, state)
            if (mapped !== undefined && mapped.seq > afterSeq) out.push(mapped)
          }
          if (out.length > 0) cursor = Math.max(cursor, out[out.length - 1]!.seq)
          return out
        } catch (error) {
          // honest degrade: [] + a debug note — never fabricated events.
          console.debug(`[remote] replay: wire session/history failed — ${error instanceof Error ? error.message : String(error)}`)
          return []
        }
      }
      // v0 degrade (protocolVersion < 2): append-only wire — no history RPC,
      // so a pre-attach gap is unreplayable. [] is honest (never fake events).
      void afterSeq
      return []
    },

    status: () => lastStatus,

    modelLabel: opts.modelLabel,

    async close(): Promise<void> {
      if (closed) return
      closed = true
      if (queue.timer !== undefined) {
        clearTimeout(queue.timer)
        queue.timer = undefined
      }
      queue.wake?.()
      off()
      await opts.client.close().catch(() => {})
    },
  }
}
