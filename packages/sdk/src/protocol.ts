// M27 R-C4: NDJSON JSON-RPC 2.0 line framing for @i-harness/sdk.
//
// The wire contract: ONE JSON-RPC 2.0 message per line (JSON.stringify +
// "\n"). Malformed lines are IGNORED (never crash the loop, never an echo);
// request ids echo into responses; error codes follow JSON-RPC:
//   -32700 parse (a decoded line that is not a valid request object),
//   -32603 internal (anything the server method throws).
// This module is pure framing — no I/O. Zero dependencies.
//
// NOTE (external contract): this file IS the sdk wire contract. Any change to
// the shapes here is a breaking protocol change for embedders.

/**
 * SDK Wire Contract v0 — FROZEN (M28 S-1, 2026-09-01).
 *
 * This is the public wire surface for @i-harness/sdk embedders. The version
 * anchor is `PROTOCOL_VERSION` (= 1; exposed as SDK_SERVER_PROTOCOL_VERSION by
 * server.ts). The field-level drift sentinel lives in test/server.test.ts
 * ("initialize wire contract v0 (field-level lock)") — changing any shape
 * below breaks it on purpose.
 *
 * Framing: ONE JSON-RPC 2.0 message per NDJSON line; request ids echo into
 * responses; malformed lines are ignored (never echo, never crash).
 *
 * Methods (client → server):
 *   initialize              → { name, version, protocolVersion, capabilities }
 *   session/prompt { sessionId, prompt }
 *                           → { sessionId, ok: true } when the turn drained;
 *                             failure → -32603 (data.event = collected events)
 *   session/status { sessionId } → { running, queued }
 *   shutdown                → { ok: true } (host teardown fires afterwards)
 * Notifications (server → client):
 *   session/event  { sessionId, event }          — append-only event stream
 *   session/status { sessionId, status, error? } — lifecycle transitions
 *
 * Error shape: { jsonrpc: "2.0", id, error: { code, message, data? } }
 * Error codes: -32700 parse · -32600 invalid request (defined; v0 never emits
 *   it — malformed lines are ignored) · -32601 method not found ·
 *   -32602 invalid params · -32603 internal.
 *
 * Replay semantics: the session/event stream is APPEND-ONLY — events are
 * pushed as they happen and are never replayed. A session's durable state
 * resumes across connections (same sessionId), but historical events are NOT
 * re-emitted to a fresh subscription.
 *
 * Versioning rules: v1 may only ADD — new methods, new notification fields,
 * new error codes. Changing or removing an existing shape/field/code is a
 * breaking change: bump PROTOCOL_VERSION and document the migration path.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SDK Wire Contract v1 — ADDITIVE-ONLY (M41a, 2026-09-04).
 *
 * PROTOCOL_VERSION is now 2. The ENTIRE v0 surface above is UNCHANGED — same
 * shapes, same methods, same error codes. v1 only ADDS:
 *
 *   initialize       → capabilities gains two rows (additive fields, nothing
 *                      removed on the v0 rows):
 *                        "session-history": ["1"]
 *                        "session-list":    ["1"]
 *                      protocolVersion is now 2 (the v0 rows stay verbatim).
 *   session/history { sessionId, afterSeq?, limit? }
 *                  → { events, nextSeq }   — always `{ events, nextSeq }`,
 *                    never null. afterSeq is EXCLUSIVE (default 0); limit
 *                    defaults to 500, clamped to a 1000 cap; the source log
 *                    is the live in-process session (service.liveSession);
 *                    nextSeq = seq of the next unreturned event (== the
 *                    source log length when the walk returned everything).
 *                    Unknown sessionId → -32602 INVALID_PARAMS with an
 *                    explicit "session not found" message (no auto-create).
 *   session/list   {}       → { sessions, listingUnavailable? } — driven by
 *                    the OPTIONAL server `listSessions` source. Absent source
 *                    → { sessions: [], listingUnavailable: true } (an honest
 *                    blank — never fabricated rows); a throwing source fails
 *                    with -32603 (fail-closed).
 *
 * A v0 client that only speaks the v0 methods is unaffected — the server
 * answers every v0 request per the v0 shapes above. Breaking-change policy
 * is unchanged: v1 (and any later version) stays additive-only.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SDK Wire Contract v1.1 addendum — M41b, 2026-09-05 (ADDITIVE-ONLY).
 *
 * v1.1 is an APPENDIX of v1: PROTOCOL_VERSION STAYS 2 (capability rows carry
 * the new surface; breaking-change policy unchanged). v1.1 only ADDS:
 *
 *   initialize       → capabilities gains two more rows:
 *                        "session-cancel": ["1"]
 *                        "session-rewind": ["1"]   (M53: host-gated — the row is
 *                                                   present only when the host
 *                                                   wired a rewindFactory)
 *   session/cancel { sessionId } → { cancelled: boolean, reason? }
 *                     The server holds the in-flight submit's AbortController
 *                     per session (session/prompt creates it) and aborts it.
 *                     cancelled:true = the in-flight submit was aborted.
 *                     cancelled:false + reason "not-running" = the session is
 *                     known and idle (nothing in flight); + reason
 *                     "not-found" = the server has never seen the session
 *                     (no live assembly / never created by this server).
 *                     Unknown sessionId → never an error frame — an honest
 *                     { cancelled: false, reason: "not-found" } answer.
 *   session/rewind/points { sessionId } → { points: [{ turnIndex, preview,
 *                     files }] }
 *   session/rewind/plan { sessionId, target, mode? }
 *                      → { clean: [{ path, op }], conflicts: [{ path, kind }],
 *                          unTracked: [string], ops: [{ path, op }] }
 *   session/rewind/execute { sessionId, target, mode? }
 *                      → { revertedFiles: number, conflicts: [{ path, kind }],
 *                          error? }
 *
 *   - The rewind request/response shapes STRUCTURALLY MIRROR packages/rewind
 *     (the wire cannot depend on the engine package — independent): the
 *     server-side host wiring maps the engine types onto these wire shapes at
 *     request time. package-specific internals (blob ids) never leak; a file
 *     op on the wire is `{ path, op: "restore-blob" | "delete-added" }`.
 *   - `mode` defaults to "all"; an invalid mode / non-integer negative target
 *     → -32602 INVALID_PARAMS (fail-closed).
 *   - Unknown sessionId → -32602 with the explicit "session not found"
 *     message (the session/history convention — rewind NEVER auto-creates).
 *   - The host may wire `rewindFactory` as absent → every rewind method
 *     answers -32603 "rewind not enabled" (an honest capability failure).
 *   - session/rewind/execute's `appendEvent` seam appends the engine's
 *     rewind/point conversation marker into the LIVE session log — the marker
 *     flows to the client on the existing session/event notification stream
 *     (no new notification; G2 owns the derived-view projection semantics).
 *
 * v1/v0 clients are unaffected: every pre-v1.1 request still answers per the
 * v0/v1 shapes (each appendix is additive-only, forever).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Task 4 addendum — M49, 2026-09-06 (ADDITIVE-ONLY).
 *
 * PROTOCOL_VERSION remains 2. Hosts advertise only the operations they wire:
 *
 *   "session-create": ["1"]
 *     session/create {} → { sessionId }
 *   "session-fork": ["1"]
 *     session/fork { sessionId } → { sessionId }
 *   "session-model": ["1"]
 *     session/model/state { sessionId } → SessionModelState
 *     session/model/set { sessionId, selection } → SessionModelState
 *
 * SessionModelState is serialization-only: it contains status, reason, ids,
 * and label, never credentials or a runtime client. Model changes reject an
 * active/queued session, persist the selection, invalidate the live assembly,
 * and resolve a fresh state. Unknown sessions follow the v1 history convention
 * (-32602 with an explicit not-found message).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Task 11 addendum — M49, 2026-09-07 (ADDITIVE-ONLY).
 *
 * PROTOCOL_VERSION remains 2.
 *
 *   "session-queue": ["1"]
 *     session/queue { sessionId } → { items: SessionQueueItem[] }
 *       — the REAL per-session queue projection (spec §8.1): the running row
 *         is always first, the rest FIFO; rows never leave the live lane
 *         (a finished turnaround is removed by the owner). A non-empty
 *         sessionId is validated; an unknown-but-valid session answers an
 *         honest empty list (nothing queued/running for it).
 *     session/queue/cancel { sessionId, id } → { cancelled }
 *       — cancel ONE queued row by its stable id: the submit settles without
 *         executing. `cancelled: false` when the id was already finished,
 *         already cancelled, or belongs to the RUNNING row (whole-turn cancel
 *         is session/cancel). Unknown ids are answered inside the success
 *         payload — never an error frame.
 *
 * session/status stays the count-only compatibility surface ({ running,
 * queued } — no rows).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Task 12 addendum — M49, 2026-09-07 (ADDITIVE-ONLY).
 *
 * PROTOCOL_VERSION remains 2.
 *
 *   "session-dashboard": ["1"]
 *     session/dashboard {} → { sessions: DashboardSessionRow[] }
 *       — the LOCAL dashboard projection (spec §8.3): the listed sessions
 *         enriched with KNOWN live fields (live/running/queued/tasks/
 *         modelLabel) — never a cost/team field (the shape has none), never a
 *         fabricated zero. A session with no listing source → the honest
 *         `listingUnavailable` blank (never rows the server did not provide).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Task 12 addendum — M49, 2026-09-07 (ADDITIVE-ONLY).
 *
 * PROTOCOL_VERSION remains 2.
 *
 *   "session-tasks": ["1"]
 *     session/tasks { sessionId } → { items: AgentTaskView[] }
 *       — the real per-session task projection (spec §8.2): subagent rows
 *         (live agents fused with their durable task records), job rows and
 *         workflow rows. Rows are plain serializable summaries — NEVER a
 *         registry object/client. A non-empty sessionId is validated; an
 *         unknown-but-valid session answers an honest empty list.
 *       WORKFLOW ATTRIBUTION: the workflow job store is run-level shared (a
 *         workflow started by session A is findable by any executor in the
 *         process). The projection attributes each workflow row to the session
 *         that started it through ITS model-facing workflow_run tool — a
 *         session's list NEVER contains another session's workflow jobs.
 *         Workflow runs initiated outside a session surface (the run-level
 *         /workflow panel, standalone runs) carry no owner and appear in NO
 *         session's projection — /workflow's own panel is their surface.
 *     session/tasks/cancel { sessionId, id } → { status }
 *       — cancel ONE task through the owning registry. `status` is
 *         "cancellation-requested" | "already-finished" (a terminal id keeps
 *         the registry's already-finished answer). Unknown ids follow the
 *         existing not-found semantics: -32602 INVALID_PARAMS with an explicit
 *         "unknown task" message (never a fabricated "already-finished").
 */

import { createInterface, type Interface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type { SessionEvent } from "@i-harness/core-session"

export const PROTOCOL_VERSION = 2

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

export interface RpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

export interface RpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

export interface RpcSuccess {
  jsonrpc: "2.0"
  id: number | string
  result: unknown
}

export interface RpcFailure {
  jsonrpc: "2.0"
  id: number | string
  error: { code: number; message: string; data?: unknown }
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure

/** M41a v1: one page of a session's event log walk (session/history). */
export interface HistoryRange {
  /** Events strictly after `afterSeq`, in seq order, at most `limit` of them. */
  events: SessionEvent[]
  /** Seq of the next unreturned event (== the log length when returned in full). */
  nextSeq: number
}

/** M41a v1: one row of a session/list result. All fields beyond `id` are
 * optional — a listing source may not be able to derive them (header-only
 * profiles give `title`; `updatedAt`/`turnCount`/context windows need deeper
 * reads). Every field is additive; consumers must tolerate absent fields. */
export interface SessionListEntry {
  id: string
  title?: string
  updatedAt?: number
  turnCount?: number
  contextUsed?: number
  contextTotal?: number
}

/** M41a v1: the session/list response payload. */
export interface SessionListResult {
  sessions: SessionListEntry[]
  /** True when no listing source was wired — proud "unknown" instead of a
   * fabricated empty list being read as "no sessions exist". */
  listingUnavailable?: boolean
}

/** Additive session/create and session/fork result. */
export interface SessionIdResult {
  sessionId: string
}

/** Public SDK selection shape. Kept structurally identical to the durable
 * SessionMeta field without coupling the wire contract to persistence. */
export interface SessionModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Serializable per-session model state. Runtime clients and credentials are
 * deliberately absent from every branch. */
export type SessionModelState =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; providerId: string; modelId: string; label: string }

// ── M41b v1.1: session/cancel + session/rewind/* wire types ─────────────────
// All shapes below STRUCTURALLY MIRROR packages/rewind's types (the wire can't
// depend on the engine package — independent); the host's server-side
// rewindFactory maps engine values onto these at request time.

/** M41b v1.1: session/cancel answer. `reason` is present only when
 * `cancelled` is false — "not-running" (the session is known and idle) or
 * "not-found" (the server has never seen the session). */
export interface CancelResult {
  cancelled: boolean
  reason?: "not-running" | "not-found"
}

/** M49 Task 11: ONE row of the session/queue projection (spec §8.1).
 * `state` is "running" only for the lane's current turn; the running row is
 * always FIRST. `order` is the per-session FIFO ordinal. */
export interface SessionQueueItem {
  id: string
  text: string
  delivery: "queue" | "steer"
  intent: "user" | "system"
  state: "queued" | "running"
  order: number
}

/** M49 Task 11: session/queue/cancel answer — `false` for a finished /
 * already-cancelled / running row id (never an error frame). */
export interface QueueCancelResult {
  cancelled: boolean
}

/** M49 Task 12: agent-task summary group (spec §8.2 — the wire never carries
 * registry objects/clients, only these serializable rows). */
export type AgentTaskGroup = "subagent" | "job" | "workflow" | "schedule"

/** M49 Task 12: agent-task summary status (error maps to failed, killed to
 * cancelled — settled and recovered states display truthfully). */
export type AgentTaskStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"

/** M49 Task 12: ONE row of the session/tasks projection. `canCancel` follows
 * the CURRENT registry state at serve time (never a UI guess); an absent
 * `parentId`/`summary`/timestamps means the owner cannot know them. */
export interface AgentTaskView {
  id: string
  parentId?: string
  group: AgentTaskGroup
  label: string
  status: AgentTaskStatus
  summary?: string
  startedAt?: number
  updatedAt?: number
  canCancel: boolean
}

/** M49 Task 12: session/tasks/cancel answer — the owning registry's outcome
 * (already-finished = the task was terminal already; an unknown id is an
 * error frame, the existing not-found semantics). */
export type TaskCancelStatus = "cancellation-requested" | "already-finished"

/** M49 Task 13 (spec §8.3): ONE session/dashboard row on the wire — the
 * session-list entry plus KNOWN live fields. Serialized only: no registry
 * object, no client, and by shape NO cost/team/cross-machine member (never
 * fabricated). Absent optional fields = the server cannot know them. */
export interface DashboardSessionRow {
  id: string
  title?: string
  updatedAt?: number
  turnCount?: number
  contextUsed?: number
  contextTotal?: number
  /** True when the session has a live assembly (honest — a listing-only
   * session is live: false, never a guessed default). */
  live: boolean
  running?: boolean
  queued?: number
  tasks?: number
  modelLabel?: string
}

/** M49 Task 13: the session/dashboard response payload. */
export interface SessionDashboardResult {
  sessions: DashboardSessionRow[]
  /** True when no listing source was wired (honest "unknown" — never read as
   * "no sessions exist"). */
  listingUnavailable?: boolean
}

/** M41b v1.1: rewind mode union (mirrors packages/rewind RewindMode). */
export type RewindMode = "all" | "files" | "conversation"

/** M41b v1.1: ONE rewind file op on the wire — mirror of the engine FileOp
 * minus the store-internal blob id (the wire never leaks store keys). `op`
 * discriminates: "restore-blob" rewrites the file from its pre-image;
 * "delete-added" removes a file the target turn created. */
export interface RewindFileOpWire {
  path: string
  op: "restore-blob" | "delete-added"
}

/** M41b v1.1: a path whose current disk state diverged from the target
 * turn's recorded after-state (externally changed since the turn ended). */
export interface RewindConflictOpWire {
  path: string
  kind: "modified" | "deleted" | "created"
}

/** M41b v1.1: one session/rewind/points row (mirror of the engine
 * RewindPointSummary). */
export interface RewindPointRowWire {
  turnIndex: number
  preview: string
  files: number
}

/** M41b v1.1: session/rewind/points response. */
export interface RewindPointsResponse {
  points: RewindPointRowWire[]
}

/** M41b v1.1: session/rewind/plan response — the lazy two-phase dry run
 * (engine semantics: clean = still-restorable-delta files, conflicts =
 * externally diverged but still executed, unTracked = recorded-later paths the
 * restore does not cover, ops = the executable file-op list — empty for a
 * "conversation" mode plan). */
export interface RewindPlanResponse {
  clean: RewindFileOpWire[]
  conflicts: RewindConflictOpWire[]
  unTracked: string[]
  ops: RewindFileOpWire[]
}

/** M41b v1.1: session/rewind/execute response — the rewind/point conversation
 * marker is appended to the LIVE session log by the server (flows on
 * session/event); `error` is present when the engine had file-op errors
 * (retry data kept — engine had_errors semantics, mirrored as a string). */
export interface RewindExecuteResponse {
  revertedFiles: number
  conflicts: RewindConflictOpWire[]
  error?: string
}

/** Transport-level RpcError: an error RESPONSE from the server (the message
 * the client rejects with). */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "RpcError"
    this.code = code
    this.data = data
  }
}

export function makeRequest(id: number | string, method: string, params?: unknown): RpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params }
}

export function makeNotification(method: string, params?: unknown): RpcNotification {
  return params === undefined
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params }
}

export function makeSuccess(id: number | string, result: unknown): RpcSuccess {
  return { jsonrpc: "2.0", id, result }
}

export function makeFailure(id: number | string, code: number, message: string, data?: unknown): RpcFailure {
  return data === undefined
    ? { jsonrpc: "2.0", id, error: { code, message } }
    : { jsonrpc: "2.0", id, error: { code, message, data } }
}

export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return (
    typeof msg === "object"
    && msg !== null
    && !Array.isArray(msg)
    && (msg as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && typeof (msg as { method?: unknown }).method === "string"
    && (typeof (msg as { id?: unknown }).id === "number" || typeof (msg as { id?: unknown }).id === "string")
  )
}

export function isRpcNotification(msg: unknown): msg is RpcNotification {
  return (
    typeof msg === "object"
    && msg !== null
    && !Array.isArray(msg)
    && (msg as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && typeof (msg as { method?: unknown }).method === "string"
    && (msg as { id?: unknown }).id === undefined
  )
}

export function isRpcSuccess(msg: unknown): msg is RpcSuccess {
  return (
    typeof msg === "object"
    && msg !== null
    && (msg as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && "id" in msg
    && "result" in msg
    && !("error" in msg)
  )
}

export function isRpcFailure(msg: unknown): msg is RpcFailure {
  return (
    typeof msg === "object"
    && msg !== null
    && (msg as { jsonrpc?: unknown }).jsonrpc === "2.0"
    && "id" in msg
    && typeof (msg as { error?: unknown }).error === "object"
    && (msg as { error?: unknown }).error !== null
  )
}

/** Encode one message as a single NDJSON line (trailing "\n"). */
export function encodeFrame(message: RpcMessage): string {
  return JSON.stringify(message) + "\n"
}

/** Decode one NDJSON line. Returns undefined for ANY malformed input
 * (non-JSON, wrong shape, old jsonrpc versions) — callers ignore those lines
 * (the framing contract). */
export function decodeFrame(line: string): RpcMessage | undefined {
  if (line === "" || line.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (isRpcRequest(parsed) || isRpcNotification(parsed) || isRpcSuccess(parsed) || isRpcFailure(parsed)) return parsed
  return undefined
}

/** NDJSON line transport over a readable (incoming lines) + writable
 * (outgoing frames). Malformed lines never reach listeners. */
export class JsonRpcLineTransport {
  private readonly listeners = new Set<(message: RpcMessage) => void>()
  private readonly rl: Interface
  private readonly output: Writable

  constructor(input: Readable, output: Writable) {
    this.output = output
    this.rl = createInterface({ input })
    this.rl.on("line", this.onLine)
  }

  private onLine = (line: string): void => {
    const message = decodeFrame(line)
    if (message === undefined) return // malformed → ignored (framing contract)
    for (const listener of [...this.listeners]) listener(message)
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  send(message: RpcMessage): void {
    this.output.write(encodeFrame(message))
  }

  /** End the output side (graceful shutdown — the peer sees stream end). */
  endWrite(): void {
    this.output.end()
  }

  /** Stop listening (does not destroy the streams; the client owns them). */
  close(): void {
    this.rl.off("line", this.onLine)
    this.listeners.clear()
  }
}
