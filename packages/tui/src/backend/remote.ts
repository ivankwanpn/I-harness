// @i-harness/tui G2 (M38b/M41a/M41b) — REMOTE backend: a BackendClient over
// the @i-harness/sdk JSON-RPC wire (v0 FROZEN — the field-level lock lives in
// packages/sdk/test/server.test.ts "initialize wire contract v0"; M41a adds
// the v1 methods session/history + session/list per the versioning rules:
// v1 may ONLY add — the v0 surface stays untouched; M41b adds the v1.1
// appendix session/cancel + session/rewind/* the same additive way —
// protocolVersion stays 2, the new surface gates on the initialize
// CAPABILITY ROWS ("session-cancel" / "session-rewind"). This is the
// `--attach <sessionId>` path: the host spawns an `i-harness sdk` stdio
// subprocess (apps/cli), the TUI drives a remote session over it.
//
// Wire surface used here (client → server):
//   initialize {}                         → { name, version, protocolVersion,
//                                           capabilities } — the handshake:
//                                           THE m41a/m41b capability
//                                           detection. The backend captures
//                                           protocolVersion AND capabilities
//                                           (once, cached); protocolVersion <
//                                           2 → the v0 degrade paths below;
//                                           the capabilities ROWS gate the
//                                           v1.1 cancel/rewind surface.
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
//   session/cancel { sessionId }          → { cancelled, reason? } (wire v1.1,
//                                           session-cancel-row GATED)
//   session/rewind/points { sessionId }   → { points: [{turnIndex, preview,
//                                           files}] } (wire v1.1, session-
//                                           rewind-row GATED)
//   session/rewind/plan { sessionId, target, mode }
//                                         → { clean, conflicts, unTracked,
//                                           ops, unseen? } (wire v1.1, same
//                                           gate — target/mode echo back from
//                                           the request into the mapped
//                                           RewindPlan; `unseen` is the M58
//                                           additive git-evidence list)
//   session/rewind/execute { sessionId, target, mode }
//                                         → { revertedFiles, conflicts,
//                                           error? } (wire v1.1, same gate;
//                                           the server appends the
//                                           rewind/point marker into the
//                                           session log — it arrives here via
//                                           the session/event notification
//                                           flow, mapped by the shared mapper
//                                           exactly as before)
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
// LOUD GAPS (each documented honestly; 2/4 are CLOSED on wire v1, 1/4 CLOSED
// on wire v1.1 and degrade to the v0 behavior on an old server — the dual
// path is at the member):
//   1. cancel — CLOSED on v1.1: session/cancel, gated by the initialize
//      capabilities ROW "session-cancel" (NOT protocolVersion — the v1.1
//      appendix keeps 2). The v0 hole is why the degrade exists: v0 had NO
//      cancel RPC (every session/prompt owns an internal AbortController; the
//      client has no handle to it) — cancel() no-ops and pushes ONE system
//      note into the stream so the UI stays honest. A v1.1 server answers
//      { cancelled: false, reason: "not-running"|"not-found" } honestly — the
//      client surfaces that as an in-stream note (never a silent no-op), and
//      a wire failure degrades to a note too.
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
//   7. rewind — CLOSED on v1.1: the OPTIONAL BackendClient.rewind member
//      (M43) is built ONLY when the handshake advertises the "session-rewind"
//      row; an old server keeps the member ABSENT (undefined) — the loop's
//      Esc-Esc rewind gate stays off, honestly (same contract as embedded's
//      no-workspace default). The member is exposed over a GETTER: the
//      handshake is async, so the member fills moments after construction —
//      the loop keys on `rewind !== undefined`, never `in`.
import type { Readable, Writable } from "node:stream"
import { createInterface, type Interface } from "node:readline"
import { spawn, type ChildProcess } from "node:child_process"
import type { SessionEvent } from "@i-harness/core-session"
import type {
  ConflictOp,
  FileOp,
  RewindExecuteError,
  RewindMode,
  RewindPlan,
  RewindPointSummary,
  RewindResult,
  UnseenChange,
} from "@i-harness/rewind"
import { createEventMapState, mapSessionEvent, type EventMapState } from "./embedded.ts"
import type { AgentTaskView, BackendClient, BackendModelState, DashboardSessionResult, DashboardSessionRow, SessionQueueItem, SessionSummary, TuiEvent } from "../contracts.ts"

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
const HISTORY_PAGE_LIMIT = 1000
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

function parseSessionIdResult(result: unknown, method: string): string {
  if (result === null || typeof result !== "object"
    || typeof (result as { sessionId?: unknown }).sessionId !== "string"
    || (result as { sessionId: string }).sessionId === "") {
    throw new SdkWireError(-32603, `malformed ${method} response: sessionId is missing`)
  }
  return (result as { sessionId: string }).sessionId
}

function parseModelState(result: unknown): BackendModelState {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session model response: result is not an object")
  }
  const state = result as Record<string, unknown>
  if (state.status === "unconfigured" && typeof state.reason === "string") {
    return { status: "unconfigured", reason: state.reason }
  }
  if (state.status === "invalid" && typeof state.reason === "string") {
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
  throw new SdkWireError(-32603, "malformed session model response")
}

// -------------------------------------------------- v1.1 response parsing
//
// The v1.1 appendix (session/cancel + session/rewind/*), the same parser
// discipline as the v1 section above: malformed TOP-LEVEL shapes are an
// SdkWireError (-32603-style internal) — NEVER a fabricated result, callers
// degrade; malformed ENTRIES inside a wire list are skipped (never a
// fabricated point row / file op / conflict). The mapped client shapes are
// the @i-harness/rewind types verbatim (contracts.ts already imports them —
// no re-decoding).

/** session/cancel result (wire v1.1): the server's honest abort answer. */
export interface CancelResult {
  cancelled: boolean
  reason?: "not-running" | "not-found"
}

/** session/rewind/points result (wire v1.1): the point list — the
 * RewindPointSummary shape verbatim (turnIndex/preview/files). */
export interface RewindPointsResult {
  points: RewindPointSummary[]
}

/** One file op on the M41b wire: { path, op } — mirror of the engine FileOp
 * minus the store-internal blob id (the wire never leaks store keys). */
export interface RewindFileOpWire {
  path: string
  op: "restore-blob" | "delete-added"
}

/** session/rewind/plan result (wire v1.1): the dry-run — the RewindPlan minus
 * target/mode, those echo back from the request (the client mapper fills them
 * into the client-side RewindPlan); file ops ride as { path, op } entries. */
export interface RewindPlanResult {
  clean: RewindFileOpWire[]
  conflicts: ConflictOp[]
  unTracked: string[]
  ops: RewindFileOpWire[]
}

/** session/rewind/execute result (wire v1.1): the slim completion summary —
 * `error` is the engine's had_errors message (a string; retry data kept
 * server-side). The embedded bookkeeping bits (truncated / eventAppended)
 * are NOT on the committed wire: they are honored only when the server
 * carries them additively, else false — the rewind/point marker itself
 * arrives via session/event independently of these two bits. */
export interface RewindExecuteResult {
  revertedFiles: number
  conflicts: ConflictOp[]
  error?: string
  truncated?: boolean
  eventAppended?: boolean
}

function parseCancelResult(result: unknown): CancelResult {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/cancel response: result is not an object")
  }
  const r = result as { cancelled?: unknown; reason?: unknown }
  if (typeof r.cancelled !== "boolean") {
    throw new SdkWireError(-32603, "malformed session/cancel response: cancelled is not a boolean")
  }
  return {
    cancelled: r.cancelled,
    ...(r.reason === "not-running" || r.reason === "not-found" ? { reason: r.reason } : {}),
  }
}

/** M49 Task 11: session/queue result — malformed ENTRIES are skipped (never a
 * fabricated row); a malformed top-level shape is an SdkWireError. */
function parseQueueResult(result: unknown): SessionQueueItem[] {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/queue response: result is not an object")
  }
  const items = (result as { items?: unknown }).items
  if (!Array.isArray(items)) {
    throw new SdkWireError(-32603, "malformed session/queue response: items is not an array")
  }
  const out: SessionQueueItem[] = []
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue
    const r = raw as { id?: unknown; text?: unknown; delivery?: unknown; intent?: unknown; state?: unknown; order?: unknown }
    if (typeof r.id !== "string" || r.id === "" || typeof r.text !== "string") continue
    if (r.delivery !== "queue" && r.delivery !== "steer") continue
    if (r.intent !== "user" && r.intent !== "system") continue
    if (r.state !== "queued" && r.state !== "running") continue
    if (typeof r.order !== "number") continue
    out.push({ id: r.id, text: r.text, delivery: r.delivery, intent: r.intent, state: r.state, order: r.order })
  }
  return out
}

function parseQueueCancelResult(result: unknown): { cancelled: boolean } {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/queue/cancel response: result is not an object")
  }
  const r = result as { cancelled?: unknown }
  if (typeof r.cancelled !== "boolean") {
    throw new SdkWireError(-32603, "malformed session/queue/cancel response: cancelled is not a boolean")
  }
  return { cancelled: r.cancelled }
}

/** M49 Task 12: session/tasks result — malformed ENTRIES are skipped (never a
 * fabricated row); a malformed top-level shape is an SdkWireError. */
function parseTasksResult(result: unknown): AgentTaskView[] {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/tasks response: result is not an object")
  }
  const items = (result as { items?: unknown }).items
  if (!Array.isArray(items)) {
    throw new SdkWireError(-32603, "malformed session/tasks response: items is not an array")
  }
  const out: AgentTaskView[] = []
  for (const raw of items) {
    if (raw === null || typeof raw !== "object") continue
    const r = raw as {
      id?: unknown; parentId?: unknown; group?: unknown; label?: unknown; status?: unknown
      summary?: unknown; startedAt?: unknown; updatedAt?: unknown; canCancel?: unknown
    }
    if (typeof r.id !== "string" || r.id === "") continue
    if (r.group !== "subagent" && r.group !== "job" && r.group !== "workflow" && r.group !== "schedule") continue
    if (typeof r.label !== "string" || r.label === "") continue
    if (r.status !== "queued" && r.status !== "running" && r.status !== "waiting"
      && r.status !== "completed" && r.status !== "failed" && r.status !== "cancelled") continue
    if (typeof r.canCancel !== "boolean") continue
    out.push({
      id: r.id,
      ...(typeof r.parentId === "string" && r.parentId !== "" ? { parentId: r.parentId } : {}),
      group: r.group,
      label: r.label,
      status: r.status,
      ...(typeof r.summary === "string" ? { summary: r.summary } : {}),
      ...(typeof r.startedAt === "number" ? { startedAt: r.startedAt } : {}),
      ...(typeof r.updatedAt === "number" ? { updatedAt: r.updatedAt } : {}),
      canCancel: r.canCancel,
    })
  }
  return out
}

/** M49 Task 13: session/dashboard result — malformed ENTRIES are skipped and
 * ONLY the known fields are carried forward (a stray "cost"/team member never
 * survives the wire — the parsed row shape has none); a malformed top-level
 * shape is an SdkWireError. Never fabricated: unknown live fields stay absent
 * AND the server's honest `listingUnavailable` verdict survives the wire (the
 * UI must render the unavailable state for it — NEVER "no sessions"). */
function parseDashboardResult(result: unknown): DashboardSessionResult {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/dashboard response: result is not an object")
  }
  const sessions = (result as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) {
    throw new SdkWireError(-32603, "malformed session/dashboard response: sessions is not an array")
  }
  const out: DashboardSessionRow[] = []
  for (const raw of sessions) {
    if (raw === null || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    if (typeof r["id"] !== "string" || r["id"] === "") continue
    if (typeof r["live"] !== "boolean") continue
    out.push({
      id: r["id"],
      // title is required on the client surface — a title-less wire row gets
      // the same honest placeholder the v0 listing stub uses (never fabricated
      // content, a display label only).
      title: typeof r["title"] === "string" ? r["title"] : "Session",
      updatedAt: typeof r["updatedAt"] === "number" ? r["updatedAt"] : 0,
      ...(typeof r["turnCount"] === "number" ? { turnCount: r["turnCount"] } : {}),
      ...(typeof r["contextUsed"] === "number" ? { contextUsed: r["contextUsed"] } : {}),
      ...(typeof r["contextTotal"] === "number" ? { contextTotal: r["contextTotal"] } : {}),
      live: r["live"],
      ...(typeof r["running"] === "boolean" ? { running: r["running"] } : {}),
      ...(typeof r["queued"] === "number" ? { queued: r["queued"] } : {}),
      ...(typeof r["tasks"] === "number" ? { tasks: r["tasks"] } : {}),
      ...(typeof r["modelLabel"] === "string" && r["modelLabel"] !== "" ? { modelLabel: r["modelLabel"] } : {}),
    })
  }
  return {
    sessions: out,
    // the honest listing verdict (true/no source; a non-boolean/malformed
    // member degrades to absent — unknown is never fabricated either way).
    ...((result as Record<string, unknown>)["listingUnavailable"] === true ? { listingUnavailable: true } : {}),
  }
}

/** M49 Task 12: session/tasks/cancel result — the owning registry's status. */
function parseTaskCancelResult(result: unknown): "cancellation-requested" | "already-finished" {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/tasks/cancel response: result is not an object")
  }
  const status = (result as { status?: unknown }).status
  if (status !== "cancellation-requested" && status !== "already-finished") {
    throw new SdkWireError(-32603, "malformed session/tasks/cancel response: status is invalid")
  }
  return status
}

/** One entry → engine FileOp. The COMMITTED wire discriminator is `op`
 * (RewindFileOpWire); a `kind`-spelled entry (a host mapping the engine
 * FileOp fields verbatim — the G1 in-flight race) is accepted too; both map
 * to the client FileOp's `kind` (an engine-side blobId rides along when the
 * server carries it — additive, never required). */
function fileOpEntry(e: unknown): FileOp | undefined {
  if (e === null || typeof e !== "object") return undefined
  const o = e as { path?: unknown; op?: unknown; kind?: unknown; blobId?: unknown }
  if (typeof o.path !== "string") return undefined
  const kind =
    o.kind === "restore-blob" || o.kind === "delete-added" ? o.kind
    : o.op === "restore-blob" || o.op === "delete-added" ? o.op
    : undefined
  if (kind === undefined) return undefined
  return {
    path: o.path,
    kind,
    ...(typeof o.blobId === "string" && o.blobId !== "" ? { blobId: o.blobId } : {}),
  }
}

function isConflictOpEntry(e: unknown): e is ConflictOp {
  if (e === null || typeof e !== "object") return false
  const o = e as { path?: unknown; kind?: unknown }
  return (
    typeof o.path === "string"
    && (o.kind === "modified" || o.kind === "deleted" || o.kind === "created")
  )
}

function fileOpEntries(raw: unknown): FileOp[] {
  if (!Array.isArray(raw)) return []
  const out: FileOp[] = []
  for (const e of raw) {
    const op = fileOpEntry(e)
    if (op !== undefined) out.push(op)
  }
  return out
}

function conflictOpEntries(raw: unknown): ConflictOp[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isConflictOpEntry)
}

/** M60 B: one wire `unseen` row ({ path, kind } — the M58 additive plan
 * member). Entry-validated like every other plan list: a malformed row is
 * skipped, never fabricated. */
function isUnseenEntry(e: unknown): e is UnseenChange {
  if (e === null || typeof e !== "object") return false
  const o = e as { path?: unknown; kind?: unknown }
  return (
    typeof o.path === "string"
    && (o.kind === "modified" || o.kind === "untracked" || o.kind === "deleted")
  )
}

function parseRewindPoints(result: unknown): RewindPointSummary[] {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/rewind/points response: result is not an object")
  }
  const points = (result as { points?: unknown }).points
  if (!Array.isArray(points)) {
    throw new SdkWireError(-32603, "malformed session/rewind/points response: points is not an array")
  }
  const out: RewindPointSummary[] = []
  for (const raw of points) {
    if (raw === null || typeof raw !== "object") continue
    const p = raw as { turnIndex?: unknown; preview?: unknown; files?: unknown }
    if (typeof p.turnIndex !== "number" || typeof p.preview !== "string" || typeof p.files !== "number") continue
    out.push({ turnIndex: p.turnIndex, preview: p.preview, files: p.files })
  }
  return out
}

function parseRewindPlan(result: unknown, target: number, mode: RewindMode): RewindPlan {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/rewind/plan response: result is not an object")
  }
  const r = result as { clean?: unknown; conflicts?: unknown; unTracked?: unknown; ops?: unknown; unseen?: unknown }
  if (!Array.isArray(r.clean) || !Array.isArray(r.conflicts) || !Array.isArray(r.unTracked) || !Array.isArray(r.ops)) {
    throw new SdkWireError(-32603, "malformed session/rewind/plan response: required arrays missing or malformed")
  }
  return {
    target,
    mode,
    clean: fileOpEntries(r.clean),
    conflicts: conflictOpEntries(r.conflicts),
    unTracked: r.unTracked.filter((s): s is string => typeof s === "string" && s !== ""),
    ops: fileOpEntries(r.ops),
    // M60 B: the M58 additive `unseen` list — absent stays absent (the wire
    // omits it when the workspace is not a git work tree / git is unavailable
    // / nothing to report); malformed rows are skipped.
    ...(Array.isArray(r.unseen) ? { unseen: r.unseen.filter(isUnseenEntry) } : {}),
  }
}

function isExecuteErrorEntry(e: unknown): e is RewindExecuteError {
  if (e === null || typeof e !== "object") return false
  const o = e as { path?: unknown; message?: unknown }
  return typeof o.path === "string" && typeof o.message === "string"
}

function parseRewindExecute(result: unknown, target: number, mode: RewindMode): RewindResult {
  if (result === null || typeof result !== "object") {
    throw new SdkWireError(-32603, "malformed session/rewind/execute response: result is not an object")
  }
  const r = result as { revertedFiles?: unknown; conflicts?: unknown; error?: unknown; truncated?: unknown; eventAppended?: unknown }
  if (typeof r.revertedFiles !== "number" || !Array.isArray(r.conflicts)) {
    throw new SdkWireError(-32603, "malformed session/rewind/execute response: revertedFiles/conflicts malformed")
  }
  const errors: RewindExecuteError[] =
    typeof r.error === "string" ? [{ path: "", message: r.error }]
    : Array.isArray(r.error) ? r.error.filter(isExecuteErrorEntry)
    : isExecuteErrorEntry(r.error) ? [r.error]
    : []
  return {
    target,
    mode,
    revertedFiles: r.revertedFiles,
    conflicts: conflictOpEntries(r.conflicts),
    errors,
    // embedded bookkeeping not on the minimal wire — honored only when the
    // server carries the fields additively; the marker arrives via
    // session/event independently of these two bits
    truncated: r.truncated === true,
    eventAppended: r.eventAppended === true,
  }
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

  /** Wire v1.1: session/cancel — the mirror's typed request helper. The
   * methods are additive (the caller gates on the handshake's session-cancel
   * row); an old server answers -32601 → SdkWireError (callers degrade). */
  async cancel(sessionId: string): Promise<CancelResult> {
    return parseCancelResult(await this.request("session/cancel", { sessionId }, REQUEST_TIMEOUT_MS))
  }

  /** Wire v1.1: session/rewind/points — the point list (typed helper). */
  async rewindPoints(sessionId: string): Promise<RewindPointSummary[]> {
    return parseRewindPoints(await this.request("session/rewind/points", { sessionId }, REQUEST_TIMEOUT_MS))
  }

  /** Wire v1.1: session/rewind/plan — the dry-run plan, target/mode suffixed
   * into the client-side RewindPlan from the request itself. */
  async rewindPlan(sessionId: string, target: number, mode: RewindMode): Promise<RewindPlan> {
    return parseRewindPlan(
      await this.request("session/rewind/plan", { sessionId, target, mode }, REQUEST_TIMEOUT_MS),
      target,
      mode,
    )
  }

  /** Wire v1.1: session/rewind/execute — the slim completion result. */
  async rewindExecute(sessionId: string, target: number, mode: RewindMode): Promise<RewindResult> {
    return parseRewindExecute(
      await this.request("session/rewind/execute", { sessionId, target, mode }, REQUEST_TIMEOUT_MS),
      target,
      mode,
    )
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
  let openGeneration = 0
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
  let pendingOpen: {
    generation: number
    sessionId: string
    events: SessionEvent[]
    status?: string
  } | undefined

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

  function applyStatus(status: string): void {
    lastStatus = status === "queued"
      ? { ...lastStatus, running: true }
      : { ...lastStatus, running: false }
  }

  function pushMappedEvent(event: SessionEvent): void {
    const mapped = mapSessionEvent(event, liveState)
    if (mapped === undefined) return
    if (mapped.type === "turn" && mapped.phase === "start") turnCount++
    pushEvent(mapped)
  }

  function commitOpen(
    id: string,
    history: SessionEvent[],
    bufferedEvents: SessionEvent[],
    bufferedStatus?: string,
  ): void {
    if (queue.timer !== undefined) {
      clearTimeout(queue.timer)
      queue.timer = undefined
    }
    queue.items.length = 0
    sessionId = id
    cursor = -1
    turnCount = 0
    cancelNoted = false
    lastStatus = { running: false, queued: 0 }
    liveState.lastSeq = -1
    liveState.chunksSinceAssistant = false

    pushEvent({ type: "session/open", sessionId: id, seq: -1, ts: Date.now() })
    const seenSeqs = new Set<number>()
    for (const event of history) {
      if (typeof event.seq === "number") seenSeqs.add(event.seq)
      pushMappedEvent(event)
    }
    for (const event of bufferedEvents) {
      if (typeof event.seq === "number") {
        if (seenSeqs.has(event.seq)) continue
        seenSeqs.add(event.seq)
      }
      pushMappedEvent(event)
    }
    if (bufferedStatus !== undefined) applyStatus(bufferedStatus)
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

  // ---- M41a/M41b capability detection: the initialize ServerInfo —
  // protocolVersion AND capabilities — captured on first wire need (the
  // handshake is fired EAGERLY at construction below) and cached. < 2 (an OLD
  // server — wire v0) → the honest dual path: replay [] and the
  // active-session list stub, exactly as before the v1 methods existed. The
  // M41b v1.1 appendix keeps protocolVersion 2 (additive-only) — the
  // cancel/rewind surface gates on the capabilities ROWS instead.
  let handshake: { protocolVersion: number; capabilities: Record<string, string[]> } | undefined

  async function probeHandshake(): Promise<{ protocolVersion: number; capabilities: Record<string, string[]> }> {
    if (handshake !== undefined) return handshake
    let h: { protocolVersion: number; capabilities: Record<string, string[]> } = { protocolVersion: 1, capabilities: {} }
    try {
      const info = (await opts.client.request("initialize", {}, REQUEST_TIMEOUT_MS)) as
        | { protocolVersion?: unknown; capabilities?: unknown }
        | null
        | undefined
      h = {
        protocolVersion: typeof info?.protocolVersion === "number" ? info.protocolVersion : 1,
        capabilities:
          typeof info?.capabilities === "object" && info.capabilities !== null && !Array.isArray(info.capabilities)
            ? (info.capabilities as Record<string, string[]>)
            : {},
      }
    } catch {
      // a server that cannot complete initialize is treated as v0 — the
      // safest degrade (no new-method calls; the stub row stays honest)
    }
    handshake = h
    return h
  }

  /** The v1 gate: protocolVersion ≥ 2 (session/history + session/list). */
  async function probeVersion(): Promise<number> {
    return (await probeHandshake()).protocolVersion
  }

  /** The v1.1 gate: a capabilities ROW is present (a non-empty array — the
   * committed shape "session-cancel": ["1"]). The ROW NAME is the runtime
   * contract: a G1 with a differently named row simply reports false → the
   * honest old-server degrade (never a guessed method call). */
  async function hasCapability(key: string): Promise<boolean> {
    const rows = (await probeHandshake()).capabilities[key]
    return Array.isArray(rows) && rows.length > 0
  }

  async function requireCapability(key: string): Promise<void> {
    if (!(await hasCapability(key))) {
      throw new Error(`${key} unavailable: server did not advertise the capability`)
    }
  }

  /** Wire v1 history — the raw wire method (the seam contract = the wire
   * names; a host's real client — typed helpers of any shape or none — always
   * speaks the same names through request()). */
  async function wireHistory(targetSessionId: string, afterSeq: number, limit?: number): Promise<HistoryResult> {
    const result = await opts.client.request(
      "session/history",
      { sessionId: targetSessionId, afterSeq, ...(limit !== undefined ? { limit } : {}) },
      REQUEST_TIMEOUT_MS,
    )
    return parseHistoryResult(result)
  }

  /** Fetch a complete history snapshot for open(). Full pages advance through
   * nextSeq; a short page is the end of the log. The target id is immutable
   * for the whole walk even while another open changes the active session. */
  async function wireFullHistory(targetSessionId: string): Promise<SessionEvent[]> {
    const events: SessionEvent[] = []
    const seenSeqs = new Set<number>()
    let afterSeq = 0
    for (;;) {
      const page = await wireHistory(targetSessionId, afterSeq, HISTORY_PAGE_LIMIT)
      for (const event of page.events) {
        if (typeof event.seq === "number") {
          if (seenSeqs.has(event.seq)) continue
          seenSeqs.add(event.seq)
        }
        events.push(event)
      }
      if (page.events.length === 0) return events
      if (!Number.isInteger(page.nextSeq) || page.nextSeq <= afterSeq) {
        throw new SdkWireError(-32603, "malformed session/history response: paging cursor did not advance")
      }
      afterSeq = page.nextSeq
    }
  }

  /** Wire v1 list — the raw wire method (same seam reasoning). */
  async function wireList(): Promise<SessionListResult> {
    const result = await opts.client.request("session/list", {}, REQUEST_TIMEOUT_MS)
    return parseListResult(result)
  }

  // ---- M41b: the conditional rewind bridge — BackendClient.rewind, the M43
  // OPTIONAL member, over the v1.1 wire methods. Present ONLY when the
  // handshake advertises the session-rewind row; an old server keeps the
  // member ABSENT (undefined) so the loop's Esc-Esc rewind gate stays off —
  // honest, same contract as embedded's no-workspace default. Exposed via a
  // GETTER over this slot: the handshake is async, so the member fills when
  // the eager probe below resolves (a few ms — before any human keypress);
  // the loop always keys on `rewind !== undefined`, never `in`.
  let rewindMember: NonNullable<BackendClient["rewind"]> | undefined

  function buildRemoteRewindMember(): NonNullable<BackendClient["rewind"]> {
    return {
      async points() {
        const result = await opts.client.request("session/rewind/points", { sessionId }, REQUEST_TIMEOUT_MS)
        return parseRewindPoints(result)
      },
      async plan(target, mode) {
        const result = await opts.client.request("session/rewind/plan", { sessionId, target, mode }, REQUEST_TIMEOUT_MS)
        return parseRewindPlan(result, target, mode)
      },
      async execute(target, mode) {
        // The server executes and APPENDS the rewind/point marker into the
        // session log (the same appendEvent path as embedded) — the marker
        // arrives back through the existing session/event notification flow
        // (mapped by the shared mapper as before); the wire result is only
        // the slim completion summary.
        const result = await opts.client.request("session/rewind/execute", { sessionId, target, mode }, REQUEST_TIMEOUT_MS)
        return parseRewindExecute(result, target, mode)
      },
    }
  }

  // ---- M49 Task 4/11: the OTHER conditional capability members — the same
  // slot pattern as rewind: a member is present ONLY when the handshake
  // advertises the capability row; on an old server the member stays ABSENT
  // (undefined) and the UI hides the action / renders unavailable honestly.
  // (M49 Task 4 made createSession/forkSession/setSessionModel capability-
  // gated per spec §4.3 — they were always-present-and-throwing before.)
  let createSessionMember: NonNullable<BackendClient["createSession"]> | undefined
  let forkSessionMember: NonNullable<BackendClient["forkSession"]> | undefined
  let setSessionModelMember: NonNullable<BackendClient["setSessionModel"]> | undefined
  let queueMember: NonNullable<BackendClient["queue"]> | undefined
  let cancelQueuedMember: NonNullable<BackendClient["cancelQueued"]> | undefined
  let tasksMember: NonNullable<BackendClient["tasks"]> | undefined
  let cancelTaskMember: NonNullable<BackendClient["cancelTask"]> | undefined
  let dashboardMember: NonNullable<BackendClient["dashboard"]> | undefined

  function capabilityRow(capabilities: Record<string, string[]>, key: string): boolean {
    const rows = capabilities[key]
    return Array.isArray(rows) && rows.length > 0
  }

  function fillMembers(h: { protocolVersion: number; capabilities: Record<string, string[]> }): void {
    if (capabilityRow(h.capabilities, "session-create")) {
      createSessionMember = async () => {
        const result = await opts.client.request("session/create", {}, REQUEST_TIMEOUT_MS)
        const id = parseSessionIdResult(result, "session/create")
        await switchSession(id)
        return id
      }
    }
    if (capabilityRow(h.capabilities, "session-fork")) {
      forkSessionMember = async () => {
        const result = await opts.client.request("session/fork", { sessionId }, REQUEST_TIMEOUT_MS)
        const id = parseSessionIdResult(result, "session/fork")
        await switchSession(id)
        return id
      }
    }
    if (capabilityRow(h.capabilities, "session-model")) {
      setSessionModelMember = async (selection) =>
        parseModelState(await opts.client.request(
          "session/model/set",
          {
            sessionId,
            selection: {
              provider: selection.provider.trim(),
              model: selection.model.trim(),
              ...(selection.reasoningEffort !== undefined
                ? { reasoningEffort: selection.reasoningEffort }
                : {}),
            },
          },
          REQUEST_TIMEOUT_MS,
        ))
    }
    if (capabilityRow(h.capabilities, "session-queue")) {
      // M49 Task 11: queue + cancelQueued ride the same wire surface.
      queueMember = async () =>
        parseQueueResult(await opts.client.request("session/queue", { sessionId }, REQUEST_TIMEOUT_MS))
      cancelQueuedMember = async (id) =>
        parseQueueCancelResult(await opts.client.request("session/queue/cancel", { sessionId, id }, REQUEST_TIMEOUT_MS))
    }
    if (capabilityRow(h.capabilities, "session-tasks")) {
      // M49 Task 12: tasks + cancelTask ride the same wire surface.
      tasksMember = async () =>
        parseTasksResult(await opts.client.request("session/tasks", { sessionId }, REQUEST_TIMEOUT_MS))
      cancelTaskMember = async (id) =>
        parseTaskCancelResult(await opts.client.request("session/tasks/cancel", { sessionId, id }, REQUEST_TIMEOUT_MS))
    }
    if (capabilityRow(h.capabilities, "session-dashboard")) {
      // M49 Task 13: session/dashboard is session-less (the WHOLE local list).
      dashboardMember = async () =>
        parseDashboardResult(await opts.client.request("session/dashboard", {}, REQUEST_TIMEOUT_MS))
    }
  }

  // Eager handshake fire: the initialize runs right away so the conditional
  // slots settle before the first keypress (and the first
  // cancel/listSessions/replay call shares the cached result instead of
  // paying this round-trip itself).
  void probeHandshake().then((h) => {
    if (capabilityRow(h.capabilities, "session-rewind")) {
      rewindMember = buildRemoteRewindMember()
    }
    fillMembers(h)
  })

  async function switchSession(id: string): Promise<void> {
    if (closed) throw new Error("remote backend closed")
    const generation = ++openGeneration
    const protocolVersion = await probeVersion()
    if (closed) throw new Error("remote backend closed")
    if (generation !== openGeneration) return

    if (protocolVersion < 2) {
      commitOpen(id, [], [])
      return
    }

    const opening: NonNullable<typeof pendingOpen> = { generation, sessionId: id, events: [] }
    pendingOpen = opening
    try {
      const history = await wireFullHistory(id)
      if (closed) throw new Error("remote backend closed")
      if (generation !== openGeneration) return
      commitOpen(id, history, opening.events, opening.status)
    } finally {
      if (pendingOpen === opening) pendingOpen = undefined
    }
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
    // M41b: the session-cancel row gates the WIRE cancel (v1.1). The v0
    // degrade (one honest note, never silent) stays ONLY for servers that do
    // not advertise the row.
    if (!(await hasCapability("session-cancel"))) {
      if (cancelNoted) return
      cancelNoted = true
      pushError("cancel unavailable over --attach (server did not advertise session-cancel)")
      return
    }
    try {
      const result = await opts.client.request("session/cancel", { sessionId }, REQUEST_TIMEOUT_MS)
      const parsed = parseCancelResult(result)
      if (!parsed.cancelled) {
        // honest no-op note: the server's AbortSignal found nothing to abort.
        pushError(
          parsed.reason === "not-found"
            ? `cancel: session ${sessionId} not found on the server`
            : "cancel: nothing to interrupt — the session is not running",
        )
      }
      // cancelled: true → the signal fired; the in-flight session/prompt ends
      // on its own (its rejection is the loop's failure toast — never faked).
    } catch (error) {
      // wire failure → an honest note (never a silent no-op), per call
      pushError(`cancel failed over --attach (${error instanceof Error ? error.message : String(error)})`)
    }
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
      if (typeof params?.sessionId !== "string" || params.event === undefined) return
      const event = params.event as SessionEvent
      if (pendingOpen?.sessionId === params.sessionId) pendingOpen.events.push(event)
      if (params.sessionId !== sessionId) return
      pushMappedEvent(event)
      return
    }
    if (n.method === "session/status" && n.params !== undefined) {
      const params = n.params as { sessionId?: unknown; status?: unknown } | undefined
      if (typeof params?.sessionId !== "string" || typeof params.status !== "string") return
      if (pendingOpen?.sessionId === params.sessionId) pendingOpen.status = params.status
      if (params.sessionId !== sessionId) return
      applyStatus(params.status)
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

    open: switchSession,

    // M49 Task 4 rule: capability members as GETTERS over the handshake slots
    // (undefined until the eager initialize fills them; on an old server,
    // never — the UI reads the absence, never a thrown error).
    get createSession() { return createSessionMember },
    get forkSession() { return forkSessionMember },
    get setSessionModel() { return setSessionModelMember },

    async modelState(): Promise<BackendModelState> {
      await requireCapability("session-model")
      return parseModelState(await opts.client.request(
        "session/model/state",
        { sessionId },
        REQUEST_TIMEOUT_MS,
      ))
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
          const replaySessionId = sessionId
          const { events } = await wireHistory(replaySessionId, afterSeq)
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

    // M49 Task 11: the queue projection — conditional on the session-queue row
    // (absent → the QueuePane renders the honest unavailable state).
    get queue() { return queueMember },
    get cancelQueued() { return cancelQueuedMember },
    // M49 Task 12: the task projection/cancel — conditional on the
    // session-tasks row (absent → the TasksPane renders the honest
    // unavailable state and hides [✗]/[stop]).
    get tasks() { return tasksMember },
    get cancelTask() { return cancelTaskMember },
    // M49 Task 13: the local dashboard projection — conditional on the
    // session-dashboard row (absent → the dashboard view renders the honest
    // unavailable state).
    get dashboard() { return dashboardMember },

    modelLabel: opts.modelLabel,

    // M41b: the conditional rewind bridge — a getter over the handshake slot
    // (undefined until the eager initialize resolves; on an old server,
    // never — Esc-Esc stays off honestly).
    get rewind() {
      return rewindMember
    },

    async close(): Promise<void> {
      if (closed) return
      closed = true
      openGeneration++
      pendingOpen = undefined
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
