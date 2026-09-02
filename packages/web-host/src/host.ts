/**
 * Web host: HTTP routes + multiplexed live streams.
 *
 * Persistence ↔ live seam (review fix): `coordinator.load()` hands out a
 * SNAPSHOT Session — a fresh object per call — so a stream bundle built over
 * it never sees appends made to the backend's own live Session instance.
 * Embedders that own the live instance must register it via
 * `host.attachLiveSession({ sessionId, session })`; the mux opener prefers
 * the attached instance over `coordinator.load()`, falling back to the
 * snapshot, then to an empty session. Attachments are caller-owned and never
 * pruned.
 *
 * C1 (gen-forward rebind): attachLiveSession ALSO re-points any cached
 * bundle for the session at the attached instance (LiveSessionStreams
 * .reattach), so streams that were opened BEFORE the attach — the SPA opens
 * its streams at session-select time, before the first command creates the
 * live agent — switch to the live session on their next pull instead of
 * staying bound to the frozen snapshot until reload.
 *
 * Stream-bundle lifecycle: per-session `LiveSessionStreams` are cached in
 * `liveStreams` with a refcount — incremented per opened stream, decremented
 * when that generator ends (end / cancel / abort / error). When the last
 * stream for a session ends, the cache entry is pruned, so the map never
 * grows with the number of sessions ever streamed. Re-opening re-derives a
 * bundle (from the attached instance when registered, else a fresh snapshot);
 * an attach re-points the cached bundle in place, so opens before and after
 * it share one live-correct bundle.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import type { Duplex } from "node:stream"
import {
  append,
  createSession,
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES_PER_MESSAGE,
  type ImageMediaType,
  type Session,
  type SessionEvent,
} from "@i-harness/core-session"
import type { ImageAttachmentRef, ImageAttachmentStore } from "@i-harness/attachment"
import type { PluginContext } from "@i-harness/core-plugin"
import type { SessionCoordinator, SessionMeta, SessionModelSelection } from "@i-harness/session-persistence"
import type { SessionQuery } from "@i-harness/session-query"
import {
  WorkspaceBadRequestError,
  WorkspaceInvalidPathError,
  WorkspaceNameConflictError,
  WorkspaceNotFoundError,
  WorkspaceUnknownSessionError,
  type WorkspaceRegistry,
} from "@i-harness/workspace"
import { CredentialRefError, CredentialShadowedError } from "@i-harness/credentials"
import { ModelProbeFailedError, ProbeUnavailableError } from "@i-harness/provider"
import {
  DEFAULT_PROVIDER_PROTOCOL,
  PROVIDER_PROTOCOLS,
  SEEDED_PROTOCOLS,
  describeSection,
  mutateSection,
  resolveProviderProtocol,
  SettingsConflictError,
  SettingsValidationError,
  type SectionOp,
  type Settings,
  type SettingsProviderConfig,
  type SettingsProviderProtocol,
  type SettingsStore,
} from "@i-harness/settings"
import {
  InstallError,
  MarketplaceFetchError,
  PluginArtifactError,
  PluginConflictError,
  PluginNotFoundError,
  SourceConflictError,
  SourceNotFoundError,
} from "@i-harness/plugin-registry"
import {
  applyGoalMutation,
  foldGoal,
  GoalStateError,
  type GoalMutationRequest,
  type GoalView,
} from "@i-harness/goal"
import { JobKillUnknownJobError, projectJobsDoc, type JobView } from "@i-harness/jobs"
import {
  createMessageFeedbackStore,
  FeedbackBadRequestError,
  FeedbackMessageNotFoundError,
  FeedbackNoteEmptyError,
  FeedbackNoteTooLargeError,
  FeedbackVersionConflictError,
  type MessageFeedbackPutRequest,
} from "@i-harness/feedback"
import type { SessionService } from "@i-harness/session-executor"
import type { AuthContext } from "./auth.ts"
import { WebSocketMuxServer } from "./mux.ts"
import { paginateEvents } from "./pagination.ts"
import { LiveSessionStreams } from "./live.ts"
import { ApprovalMuxBridge } from "./approval.ts"
import { QuestionMuxBridge } from "./questions.ts"
import type { GoalOperation } from "@i-harness/core-session"
import type { CommandBridge, CommandEventWire, CommandRequestWire, CommandExecuteRequestWire, FileReferencesBridge, JobKillBridge, ModelSources, PluginRegistryFace } from "./types.ts"
import { buildModelsCatalog, mergeDirectoryRows, sectionUserProviders, upsertModelRows } from "./models.ts"

// C5 route-local base64 validators (the branch had them in core-session; m26
// core-session keeps its append-time validation only, and the upload route
// revalidates the canonical form before any store write).
const IMAGE_B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
function isValidCanonicalBase64(value: string): boolean {
  return IMAGE_B64_RE.test(value)
}
function imageBase64ByteLength(value: string): number {
  return Math.floor((value.length * 3) / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0)
}

// ── Task 3.2 session title rules (DSH session-title simplified) ─────────────
// DSH normalizes (cleans) and truncates silently; a silently-edited title is
// the silent-drop bug class, so WE validate and REJECT instead: non-blank
// after trim, single-line (no control characters — a title is a one-line
// display label), at most 200 UTF-16 code units. Stored in SessionMeta.title
// (jsonl header / sqlite column) — deliberately NOT a SessionEvent (additive
// ruling: rename is a metadata rewrite, no log event type invented).
export const MAX_SESSION_TITLE_LENGTH = 200

// Task 5.4b file-reference query cap (keystroke surface): at most this many
// UTF-16 code units after "@". Longer → 400; the walker never sees the text.
export const MAX_FILE_QUERY_LENGTH = 200
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001f\u007f]/

function normalizeSessionTitle(raw: unknown): { ok: true; title: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "title must be a string" }
  const title = raw.trim()
  if (title === "") return { ok: false, message: "session title must be a non-blank string" }
  if ([...title].length > MAX_SESSION_TITLE_LENGTH) {
    return { ok: false, message: `session title must be at most ${MAX_SESSION_TITLE_LENGTH} characters` }
  }
  if (SESSION_TITLE_CONTROL_RE.test(title)) {
    return { ok: false, message: "session title must be a single line (no control characters)" }
  }
  return { ok: true, title }
}

// Task 5: POST /api/sessions/:id/model body shape — non-empty strings after
// trim, reasoningEffort optional and non-empty when present (forward-compatible
// passthrough; a future effort level degrades provider-side, the enum closed
// set only lives in the settings section schema). `undefined` = invalid (400
// session-model-invalid — validation REJECTS rather than silently normalizes).
// Provider validity is deliberately NOT checked here: a custom route the user
// registers later must stay usable, and an unresolvable provider falls back to
// the mock + warn at agent-build time (the resolution chain's honest fallback).
function parseSessionModelSelection(raw: Record<string, unknown>): SessionModelSelection | undefined {
  if (typeof raw.provider !== "string" || raw.provider.trim() === "") return undefined
  if (typeof raw.model !== "string" || raw.model.trim() === "") return undefined
  if (raw.reasoningEffort !== undefined
    && (typeof raw.reasoningEffort !== "string" || raw.reasoningEffort.trim() === "")) return undefined
  return {
    provider: raw.provider.trim(),
    model: raw.model.trim(),
    ...(raw.reasoningEffort !== undefined ? { reasoningEffort: (raw.reasoningEffort as string).trim() } : {}),
  }
}

// Backend-specific "no such session" signals that route to HTTP 404: jsonl
// surfaces ENOENT (header read / meta rewrite), sqlite throws a plain Error
// with the `unknown session: <id>` message (its getSession contract).
function isUnknownSessionError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
    || (error instanceof Error && error.message.startsWith("unknown session:"))
}

// ── Task 6: plugin-registry error mapping (task 4/5, host-private) ───────────
// One table that must agree with the registry's error classes; the plugin
// routes call it (forwardFeedbackError pattern) and everything else reaches
// the generic 500 catch — never a silent drop.
//   SourceNotFoundError / PluginNotFoundError → 404 (referenced row missing)
//   SourceConflictError / PluginConflictError → 409 (name/id conflict)
//   PluginArtifactError / MarketplaceFetchError → 400 (client bug or bad
//     artifact — a well-formed request against a state the client can see)
//   InstallError "plugin-invalid" → 400 (malformed input); "install-failed"
//     is a server-side failure → 500 (generic catch)
function forwardPluginRegistryError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof SourceNotFoundError || error instanceof PluginNotFoundError) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: error.message, code: error.code }))
    return true
  }
  if (error instanceof SourceConflictError || error instanceof PluginConflictError) {
    res.writeHead(409, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: error.message, code: error.code }))
    return true
  }
  if (error instanceof PluginArtifactError
    || error instanceof MarketplaceFetchError
    || (error instanceof InstallError && error.code === "plugin-invalid")) {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: error.message, code: error.code }))
    return true
  }
  return false
}

// ── Task 4 (models plan): model-sources error mapping (host-private) ─────────
// Same table shape as forwardPluginRegistryError. The seam's typed errors:
//   SettingsConflictError → 409 (stale expectedRevision, carries {expected, actual})
//   SettingsValidationError / CredentialRefError → 400 (with their codes)
//   CredentialShadowedError → 400 credential-rejected (env-provided ref write)
//   ModelProbeFailedError / ProbeUnavailableError → 400 probe failures (the
//     probe existed but failed vs no probe exists — the T3 ruling: both are
//     the 400 family, each carrying its own code for the UI message).
function forwardModelsError(res: ServerResponse, error: unknown): boolean {
  if (error instanceof SettingsConflictError) {
    res.writeHead(409, { "content-type": "application/json" })
    res.end(JSON.stringify({
      error: error.message,
      code: error.code,
      expected: error.expected,
      actual: error.actual,
    }))
    return true
  }
  if (error instanceof SettingsValidationError
    || error instanceof CredentialRefError
    || error instanceof CredentialShadowedError
    || error instanceof ModelProbeFailedError
    || error instanceof ProbeUnavailableError) {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: error.message, code: error.code }))
    return true
  }
  return false
}

/** Shape-guard for POST /api/settings/mutate ops: an array of
 * {op: "set"|"unset", path: non-empty string[], value?}. Section-schema
 * validation itself is mutateSection's job (SettingsValidationError → 400);
 * this only separates client bugs (wrong JSON shape → 400 settings-mutate-invalid)
 * from well-formed ops that violate the schema. `undefined` = invalid. */
function parseSectionOps(raw: unknown): SectionOp[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const ops: SectionOp[] = []
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined
    const rec = entry as Record<string, unknown>
    if (rec.op !== "set" && rec.op !== "unset") return undefined
    if (!Array.isArray(rec.path)
      || rec.path.length === 0
      || !rec.path.every((seg) => typeof seg === "string" && seg !== "")) {
      return undefined
    }
    if (rec.op === "set" && !("value" in rec)) return undefined
    ops.push(rec.op === "set"
      ? { op: "set", path: rec.path as string[], value: rec.value }
      : { op: "unset", path: rec.path as string[] })
  }
  return ops
}

// Attachment ids are opaque `att-<uuid>` keys (attachment store contract — the
// id is NEVER a filesystem path, and resolvePath joins by it). A URL-supplied
// id is validated against this grammar BEFORE any store call, so a crafted id
// (`../x`, `%2e%2e%2f`, …) cannot traverse out of the attachments dir.
const ATTACHMENT_ID_RE = /^att-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

/** M27-H-1: the version GET /api/health reports when the embedder passes no
 * `version` (the CLI injects its package.json version). */
export const DEFAULT_HOST_VERSION = "0.1.0"

export interface WebHostOptions {
  port: number
  /**
   * M27-H-1: version string served by GET /api/health ({ healthy, version }).
   * The embedder passes its own (the CLI injects apps/cli package.json); the
   * host default is `DEFAULT_HOST_VERSION`. Absent → still served (a health
   * probe must never depend on an optional seam).
   */
  version?: string
  /**
   * R-C0 (engine-owned): the per-session service behind the mux `command`
   * endpoint — submit(sessionId, prompt, signal) starts/continues the session's
   * serial turn lane and RESOLVES when the turn completes; a lane failure
   * REJECTS the submit (A-plan drain contract) and the opener maps it to an
   * `{status:"error"}` frame. Absent → `command` opens fail with an error
   * frame. The service's assemblies arrive via `onAssembly`; the embedder
   * registers them through `attachLiveSession` (the CLI composes both).
   */
  executor?: SessionService
  coordinator?: SessionCoordinator
  /** R-C3 auth fence: absent → no auth (dev/test); present → every HTTP route
   * answers 401 without session-cookie/token, every mux upgrade is rejected
   * before upgrade, the DNS-rebind fence runs FIRST (403), CORS/OPTIONS on
   * allowed origins. */
  auth?: AuthContext
  /**
   * Task 1.2 session-query seam: when provided, the host serves
   * `GET /api/sessions/search` + `GET /api/sessions/:id/lineage` over it
   * (FTS5 search / session lineage from @i-harness/session-query). Absent —
   * the DEFAULT jsonl backend, which has no FTS index — both endpoints answer
   * HTTP 409 with `{ error, code: "search_not_enabled" }` (documented shape,
   * task 1.2 brief: 「未启用」/ frontend hint) so the frontend can detect and
   * announce the missing sqlite precondition instead of a generic 500.
   */
  sessionQuery?: SessionQuery
  /**
   * Global settings store (dsh settings-file parity): when provided, the
   * host serves `GET/PUT /api/settings` over it. Absent → those routes 404,
   * so an API-only embedder without settings support stays unchanged.
   */
  settings?: SettingsStore
  /**
   * Image attachment store (task 1.3): when provided, the host serves the
   * attachment routes over it — `POST /api/attachments` (JSON upload,
   * validated with core-session's ImageInput rules: supported media types,
   * canonical base64, MAX_IMAGE_BYTES_PER_MESSAGE) and
   * `GET /api/attachments/:id?mediaType=<type>` (the stored bytes with that
   * content-type). The embedder composes a `createImageAttachmentStore` over
   * `<workspace>/.i-harness/attachments` and hands it in; the host never
   * invents storage. Absent → both routes 404.
   */
  attachments?: ImageAttachmentStore
  context?: PluginContext
  /**
   * Approval bridge behind the mux `approval` endpoint + `{type:"approval"}`
   * client messages. The embedder constructs it over the PluginContext its
   * live agent asks approvals on (B3-H3 wires the live-agent answerer → the
   * bridge's waterfall) and calls `attach()` on it. Absent → `approval`
   * opens fail with an error frame and approval messages are ignored.
   */
  approvalBridge?: ApprovalMuxBridge
  /**
   * Question bridge behind the mux `question` endpoint + `{type:"answer"}`
   * client messages (task 3.3). The embedder constructs it over the
   * PluginContext its live agent asks questions on (web.ts wires the
   * live-agent provider → the bridge's waterfall) and calls `attach()` on it.
   * Absent → `question` opens fail with an error frame and answer messages
   * are ignored.
   */
  questionBridge?: QuestionMuxBridge
  /**
   * Commands RPC bridge (task 4.1 — DSH commands.{list,execute} over OUR
   * HTTP idiom): when provided, the host serves GET /api/commands (the
   * registered commands' descriptors, for the SPA palette's upfront list)
   * and POST /api/commands/execute ({ sessionId, line } → { result }) over
   * it. Commands are UI-plane operations dispatched through
   * @i-harness/interaction's own registry — the bridge is the embedder's
   * runner, which resolves the target registry context (server ctx or the
   * session's live-agent ctx) and NEVER feeds a result into model history
   * (audit F05-6). Note the mux `command` endpoint is a DIFFERENT seam: it
   * submits a prompt turn to the agent. Absent → both routes 404
   * (API-only embedders unchanged), like the settings seam.
   */
  commandBridge?: CommandBridge
  /**
   * Workspace registry (task 3.1 — DSH workspace-controller parity: create/
   * rename/list + session attach; the embedder composes it over its
   * coordinator, e.g. `createWorkspaceRegistry(coordinator)` from
   * @i-harness/workspace). When provided, the host serves `GET/POST
   * /api/workspaces` + `PUT /api/workspaces/:id` over it, POST /api/sessions
   * honors `cwd` / `workspaceId`, GET /api/sessions joins each row's
   * `workspaceId` + `archived` flag, and fork/archive/unarchive set use it.
   * Absent → the workspace routes 404, archive/unarchive 404, fork runs
   * without workspace attach, and `cwd`/`workspaceId` are dropped from the
   * session meta.
   */
  workspaceRegistry?: WorkspaceRegistry
  /**
   * File-references bridge (task 5.4b — DSH fileReferences.list parity,
   * minimal: the @ reference picker's candidate source. The embedder composes
   * it over the workspace registry + @i-harness/workspace's bounded walk
   * (`listWorkspaceFiles` — caps/skips/case-insensitive-substring matching
   * are the walker's domain, see that module)). When provided, the host
   * serves `GET /api/workspaces/:id/files?q=<substr>` →
   * { files: [{ path, name, type }] } over it (workspace-relative paths,
   * "/" separators). Absent → the route 404s like every optional seam.
   * Unknown workspace ids answer 404 (WorkspaceNotFoundError mapped by the
   * route); an over-long `q` answers 400 (client bug, never a silent
   * truncation). SESSION candidates intentionally need NO new endpoint: the
   * SPA's picker uses the existing GET /api/sessions `?q=` meta search
   * (title/id substring) — the task's ruling.
   */
  fileReferences?: FileReferencesBridge
  /**
   * Jobs kill bridge (task 5.5 — the jobs popover's kill button; DSH
   * job_kill web-化). The embedder composes it over the live agent's subagent
   * job registry (the SAME machinery the model-facing `job_kill` tool calls
   * for subagent jobs — see types.ts JobKillBridge for the semantics). When
   * provided, the host serves `POST /api/sessions/:id/jobs/:jobId/kill` →
   * { outcome } ("cancellation-requested" | "already-finished"); a job id the
   * registry does not know answers 409 { error } (JobKillUnknownJobError),
   * an unknown session answers 404 (events-route parity), and the bridge
   * itself absent answers 404 (optional-seam semantics — API-only embedders
   * unchanged, exactly like the settings/commands seams).
   */
  jobKillBridge?: JobKillBridge
  /**
   * Plugin registry seam (task 6 — DSH/Claude marketplace parity over OUR
   * HTTP idiom). When provided, the host serves the /api/plugins routes over
   * it: GET catalog (registered sources + merged discovery), GET runtime
   * (evaluated plugin status views), POST source ({ source } → add,
   * :name/refresh → re-pull), DELETE source/:name, POST :id/{install,
   * uninstall, enable, disable}. The host is transport-only — it NEVER touches
   * the registry's internals nor the evaluator; the embedder composes the seam
   * (apps/cli Task 8: PluginRegistry + runtime observations → runtime views).
   * Absent → every /api/plugins route answers 404 (settings/commands seam
   * pattern — API-only embedders unchanged). No immediate events: the SPA
   * refetches after each operation (the repo's preferences convention).
   */
  pluginRegistry?: PluginRegistryFace
  /**
   * Model-settings seam (task 4 of the models plan — settings sections /
   * credentials / LLM directory+probe / models catalog). The embedder composes
   * it over @i-harness/settings' SettingsStore (sections), a
   * @i-harness/credentials store and @i-harness/provider's registry (see
   * types.ts ModelSources for the minimal faces + the adapter contract). When
   * provided, the host serves:
   *   GET  /api/settings/sections?name=llm|onboarding|core → SectionView
   *   POST /api/settings/mutate {name, ops, expectedRevision?} → SectionView
   *        (409 {expected, actual} on a stale revision)
   *   GET  /api/credentials?refs=…  POST /api/credentials  DELETE /api/credentials/:ref
   *   GET  /api/llm/directory       POST /api/llm/probe {route, baseURL?, apiKey?, protocol?}
   *        (directory = declared seeds ⊕ user-section routes; the probe's
   *        protocol is resolved server-side — section > seeded > SPA draft
   *        (an UNSAVED route only, the create dialog) > default)
   *   GET  /api/models/catalog      → {default, groups, failures}
   * EACH piece is optional: absent → the corresponding routes 404
   * (settings/commands seam pattern — API-only embedders unchanged). The host
   * is transport-only (wire shapes + error mapping, forwardModelsError); it
   * never touches the packages' internals. POST /api/sessions/:id/model
   * (per-session model selection) is Task 5's: it owns SessionMeta
   * .modelSelection and is routed in the Task 5 block below (coordinator-
   * owned — no seam piece needed).
   */
  modelSources?: ModelSources
}

/** attachLiveSession() argument: the live Session instance the embedder appends to. */
export interface WebHostSessionLiveOptions {
  sessionId: string
  session: Session
}

export interface WebHost {
  listen(): Promise<{ port: number }>
  close(): Promise<void>
  /**
   * Persistence ↔ live seam: register the LIVE Session instance for
   * `sessionId` (see the module header). Streams opened before the attach
   * are re-pointed at the instance (bundle gen-forward rebind), so appends
   * made to it flow over them immediately; new opens derive from the
   * attached instance. Attachments are caller-owned and never pruned.
   */
  attachLiveSession(options: WebHostSessionLiveOptions): void
}

interface LiveEntry {
  bundle: LiveSessionStreams
  /** Open streams over this bundle; the entry is pruned at 0. */
  refs: number
}

export function createWebHost(opts: WebHostOptions): WebHost {
  const coordinator: SessionCoordinator | undefined = opts.coordinator
  const executor = opts.executor
  const auth = opts.auth
  const approvalBridge = opts.approvalBridge
  const questionBridge = opts.questionBridge
  const commandBridge = opts.commandBridge
  const settings = opts.settings
  const sessionQuery = opts.sessionQuery
  const attachments = opts.attachments
  const workspaceRegistry = opts.workspaceRegistry
  const fileReferences = opts.fileReferences
  const jobKillBridge = opts.jobKillBridge
  const pluginRegistry = opts.pluginRegistry
  // Task 4 (models plan): model-settings seam — each piece optional (see the
  // WebHostOptions comment; the routes below answer 404 per missing piece).
  const modelSources = opts.modelSources
  // Task 4.3: message feedback store over the coordinator's generic document
  // store (DSH message-feedback parity — see feedback.ts). Unlike the
  // settings/attachments/workspace seams there is NO optional seam: feedback
  // persistence needs nothing the host does not already require (the
  // coordinator), and the only consumer is the SPA over these routes, so the
  // store is composed here and the routes answer 500 on a missing coordinator
  // exactly like the session/goal routes (never a silent 404).
  const feedbackStore = coordinator === undefined ? undefined : createMessageFeedbackStore(coordinator)
  // Attached live Session instances (persistence ↔ live seam): the embedder
  // registers the instance it appends to; the opener prefers it over
  // coordinator.load()'s snapshot. Caller-owned, never pruned.
  const liveSessions = new Map<string, Session>()
  // Refcounted per-session stream bundles — pruned when the last open stream
  // for the session ends (see module header).
  const liveStreams = new Map<string, LiveEntry>()

  function releaseLive(sessionId: string): void {
    const entry = liveStreams.get(sessionId)
    if (entry === undefined) return // entry was dropped (e.g. re-attached) — nothing to release
    entry.refs -= 1
    if (entry.refs <= 0) liveStreams.delete(sessionId)
  }

  // Keeps the refcount honest: decrements when the wrapped generator ends on
  // ANY path (end, cancel, abort, error), pruning the cache entry at zero.
  function tracked<T>(sessionId: string, source: AsyncIterable<T>): AsyncIterable<T> {
    return (async function* () {
      try {
        for await (const value of source) yield value
      } finally {
        releaseLive(sessionId)
      }
    })()
  }

  /** Frame mapper over the session service (R-C0: serialization is the
   * EXECUTOR's job; the host only shapes status frames and races the client
   * signal). A drain rejection (A-plan: reject-on-first-turn-failure) becomes
   * the error frame; a torn-down stream never sends ok/error. */
  function commandStream(
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
  ): AsyncGenerator<CommandEventWire> {
    return (async function* () {
      yield { status: "started" }
      const outcome = await Promise.race([
        executor!.submit(sessionId, prompt, signal)
          .then(() => ({ status: "ok" }) as const)
          .catch((error: unknown) => ({ status: "error", error: String(error) }) as const),
        new Promise<undefined>((resolve) => {
          if (signal.aborted) resolve(undefined)
          else signal.addEventListener("abort", () => resolve(undefined), { once: true })
        }),
      ])
      if (outcome === undefined) return // torn down — never send to a gone client
      yield outcome
    })()
  }

  const mux = new WebSocketMuxServer(async (endpoint, payload, signal) => {
    // Approval stream (controller ruling 2): a global channel carrying every
    // emitted ApprovalRequestWire — no sessionId payload, no live bundle, no
    // refcount. The stream stays open; decisions arrive as `{type:"approval"}`
    // messages, which the mux routes to approvalBridge.respond().
    if (endpoint === "approval") {
      if (approvalBridge === undefined) throw new Error("approval endpoint not configured")
      return approvalBridge.open(signal)
    }
    // Question stream (task 3.3): the same global channel as approval —
    // every emitted QuestionRequestWire, no sessionId payload; answers arrive
    // as `{type:"answer"}` messages routed to questionBridge.respond().
    if (endpoint === "question") {
      if (questionBridge === undefined) throw new Error("question endpoint not configured")
      return questionBridge.open(signal)
    }
    const sessionId = String((payload as { sessionId?: string }).sessionId ?? "")
    if (sessionId === "") throw new Error("sessionId required")
    // Command stream (controller ruling 3): run the agent for one session via
    // the session service (R-C0 — serialization is the executor's job).
    if (endpoint === "command") {
      if (executor === undefined) throw new Error("command endpoint not configured")
      const request = payload as Partial<CommandRequestWire>
      if (typeof request.prompt !== "string") throw new Error("prompt required")
      return commandStream(sessionId, request.prompt, signal)
    }
    // Validate the endpoint BEFORE touching the cache so an unknown endpoint
    // cannot leave a refcount-0 cache entry behind.
    if (endpoint !== "session" && endpoint !== "chunk" && endpoint !== "reasoning" && endpoint !== "agent-state") {
      throw new Error(`live endpoint not implemented: ${endpoint}`)
    }
    let entry = liveStreams.get(sessionId)
    if (entry === undefined) {
      // Seam: prefer the attached LIVE instance (backend appends flow into the
      // streams); then the session service's live assembly (the R-C0 path —
      // the executor owns the live instance even before the embedder calls
      // attachLiveSession, e.g. a stream opened between the assembly create
      // and the attach); then the coordinator's snapshot; last resort an
      // empty session so streams still open (and stay silent). A session that
      // attaches LATER is covered too — attachLiveSession re-points the cached
      // bundle (gen-forward), so pre-attach streams switch to it.
      const session = liveSessions.get(sessionId)
        ?? executor?.liveSession(sessionId)
        ?? (coordinator === undefined ? undefined : (await coordinator.load(sessionId))?.session)
        ?? createSession()
      // Re-check after the load await: concurrent opens of the SAME session
      // (the SPA opens session/chunk/agent-state back-to-back) all miss the
      // cache above and resume here — the first continuation to run sets the
      // entry, the others must join it instead of overwriting it with their
      // own bundle (which would strand the earlier streams on an unmanaged
      // bundle: no shared refcount, and attachLiveSession's rebind would miss
      // them). Continuations are atomic, so re-check + set cannot interleave.
      entry = liveStreams.get(sessionId)
      if (entry === undefined) {
        entry = { bundle: new LiveSessionStreams(session), refs: 0 }
        liveStreams.set(sessionId, entry)
      }
    }
    entry.refs += 1
    const live = entry.bundle
    const source: AsyncIterable<unknown> = endpoint === "session"
      ? live.events(signal)
      : endpoint === "chunk"
        ? live.chunks(signal)
        : endpoint === "reasoning"
          ? live.reasonings(signal)
          : live.agentState(signal)
    // The mux's per-stream AbortSignal flows into the generators: abort →
    // return, so stream teardown (cancel, socket close, mux.close()) never
    // waits on a parked generator. `tracked` releases the refcount when the
    // generator finishes, pruning the cache entry when the LAST stream for
    // the session ends.
    return tracked(sessionId, source)
  }, {
    // Client approval decisions (`{type:"approval"}` messages) → the bridge's
    // waterfall (controller ruling 1). No bridge configured → ignored; its
    // `approval` opens already fail with an error frame.
    onApproval: (value) => { approvalBridge?.respond(value) },
    // Client question answers (`{type:"answer"}` messages) → the bridge's
    // waterfall (task 3.3). No bridge configured → ignored; its `question`
    // opens already fail with an error frame.
    onAnswer: (value) => { questionBridge?.respond(value) },
  })

  const server = createServer((req, res) => {
    // Route failures (bad JSON body, unknown session id, …) must not become
    // unhandled rejections — they crash the process. Own the response: 500.
    void route(req, res).catch((error: unknown) => {
      if (res.writableEnded) return
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: String(error) }))
        return
      }
      res.destroy()
    })
  })
  // ── R-C3 auth guard (host-private) ────────────────────────────────────────
  function parseCookieHeader(raw: string | undefined): Record<string, string> {
    const out: Record<string, string> = {}
    if (raw === undefined) return out
    for (const part of raw.split(";")) {
      const i = part.indexOf("=")
      if (i === -1) continue
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
    return out
  }

  // Returns true when the request MAY proceed; false when it was answered.
  // The DNS-rebind fence runs FIRST — a bad Host/Origin fails before any auth
  // check; OPTIONS answers the CORS preflight (allow-list = loopback origins,
  // already fence-verified); then cookie-or-token auth.
  function guardAndAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (auth === undefined) return true
    const url = new URL(req.url ?? "/", "http://localhost")
    if (!auth.hostAllowed(req.headers.host)) {
      res.writeHead(403, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "forbidden host" }))
      return false
    }
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined
    if (!auth.originAllowed(origin)) {
      res.writeHead(403, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "forbidden origin" }))
      return false
    }
    if (req.method === "OPTIONS") {
      const headers: Record<string, string> = {
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type",
        vary: "Origin",
      }
      if (origin !== undefined) headers["access-control-allow-origin"] = origin
      res.writeHead(204, headers)
      res.end()
      return false
    }
    const cookie = parseCookieHeader(req.headers.cookie)
    if (auth.verifySession(cookie[auth.cookieName()])) return true
    const token = url.searchParams.get("token")
    if (token !== null && auth.tokenValid(token)) return true
    res.writeHead(401, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "unauthorized" }))
    return false
  }

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/mux") { socket.destroy(); return }
    // R-C3: fence + auth BEFORE upgrade; the query token is allowed (WS
    // clients/curl).
    if (auth !== undefined) {
      if (!auth.hostAllowed(req.headers.host)) { socket.destroy(); return }
      const url = new URL(req.url, "http://localhost")
      const cookie = parseCookieHeader(req.headers.cookie)
      const token = url.searchParams.get("token")
      if (!auth.verifySession(cookie[auth.cookieName()]) && !auth.tokenValid(token ?? undefined)) {
        socket.destroy()
        return
      }
    }
    mux.handleUpgrade(req, socket as Duplex, head)
  })

  // ── Task 4.2: goal projection + mutations (DSH goal parity simplified) ────
  // One projection per session folded from `goal/change` session events (see
  // goal.ts). The routes below read it (GET) or validate body + CAS ref +
  // transition, append the durable event to the session log — the DSH way:
  // the event IS the change, there is no separate state store — and answer
  // the freshly projected view. Every mutation is CAS (ref from the last
  // GET); a conflict answers 409 with a machine-readable code (goal-none /
  // goal-stale-ref / goal-exists / goal-invalid-transition) and the frontend
  // refreshes + surfaces the message, never a silent drop.
  //
  // Read source (fix round 1): the coordinator's DURABLE snapshot only — the
  // events-route posture. The attached LIVE instance starts EMPTY (live-agent
  // seeds no history and subscribe() replays nothing; a restart re-attach
  // looks the same), so reading it would silently lose a goal set before the
  // first message of a session — the goal-first canonical flow. Appends
  // mirror the mux write path: a live append still goes to the attached
  // instance (mux-visible) and the route then AWAITS coordinator.flush so the
  // durable snapshot carries the mutation before the response and a backend
  // write failure surfaces as the route's 500 instead of a silent 200 (the
  // write-behind's batched ≤200 ms window is not a reason to hide failures).
  async function sessionForGoal(sessionId: string): Promise<Session> {
    return (await coordinator!.load(sessionId)).session
  }

  async function appendGoalEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const live = liveSessions.get(sessionId)
    if (live !== undefined) {
      append(live, event)
      // The live mirror is a batched write-behind: flush it now so (a) the
      // snapshot the next read folds already carries this mutation (no
      // read-before-flush window after the response) and (b) a backend write
      // failure rejects and becomes the response error — never a silent drop.
      await coordinator!.flush(sessionId)
      return
    }
    await coordinator!.append(sessionId, [event])
  }

  async function settleGoalMutation(
    res: ServerResponse,
    sessionId: string,
    operation: GoalOperation,
    request: GoalMutationRequest,
  ): Promise<boolean> {
    try {
      const session = await sessionForGoal(sessionId)
      const current = foldGoal(session.events)
      const { event, next } = applyGoalMutation(current, operation, request, Date.now())
      await appendGoalEvent(sessionId, event)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ goal: next }))
      return true
    } catch (error) {
      if (error instanceof GoalStateError) {
        // Request-level shape problems are client bugs (400); state conflicts
        // (CAS, no current goal, bad transition, goal exists) are 409 so the
        // frontend treats them as "refresh + surface", not "retry blindly".
        const status = error.code === "goal-invalid" ? 400 : 409
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: error.message, code: error.code }))
        return true
      }
      if (isUnknownSessionError(error)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `session not found: ${sessionId}` }))
        return true
      }
      throw error
    }
  }

  async function readGoalBody(req: IncomingMessage, res: ServerResponse): Promise<GoalMutationRequest | undefined> {
    return (await readJsonObject(req, res, "goal-invalid")) as GoalMutationRequest | undefined
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // R-C3: fence + CORS + cookie-or-token FIRST (every route, before any
    // dispatch).
    if (!guardAndAuth(req, res)) return
    const url = new URL(req.url ?? "/", "http://localhost")
    // R-C3: login — the `?token=<launch>` bootstrap (already accepted by the
    // guard), sets the session cookie (SameSite=Strict + loopback-only fence
    // = dsh-shaped browser auth for a local service).
    // M27-H-1: health — no seams required (a probe/embedder ping; the 401
    // fence would close the door, so it answers BEFORE guardAndAuth would
    // matter only when auth is absent — the guard already ran above, and a
    // fenced host deliberately keeps /api/health behind the same fence).
    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ healthy: true, version: opts.version ?? DEFAULT_HOST_VERSION }))
      return
    }
    if (req.method === "GET" && url.pathname === "/api/auth/login") {
      if (auth === undefined) { res.writeHead(404); res.end(); return }
      const token = url.searchParams.get("token")
      if (token === null || !auth.tokenValid(token)) {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid launch token" }))
        return
      }
      const session = auth.signSession()
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": `${auth.cookieName()}=${session}; HttpOnly; SameSite=Strict; Path=/`,
      })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    // Settings (`GET` snapshot / `PUT` upsert). Absent store → 404 so an
    // embedder without settings support behaves exactly as before.
    if (req.method === "GET" && url.pathname === "/api/settings") {
      if (settings === undefined) { res.writeHead(404); res.end(); return }
      await settings.load()
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ settings: settings.get() }))
      return
    }
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      if (settings === undefined) { res.writeHead(404); res.end(); return }
      const body = await readJson(req)
      const next = await settings.set(body as Partial<Settings>)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ settings: next }))
      return
    }
    // ── Task 4.1: commands RPC (DSH commands.{list,execute} parity) ─────────
    // Commands are UI-plane (audit F05-6): they run through the interaction
    // registry and their results are handed back to the caller — never a
    // model message, never an agent turn. HTTP (not the mux) is the deliberate
    // fit: the SPA palette needs the list upfront as one-shot GET, and an
    // execution is a single request/response over a quick handler (results
    // need no streaming frames). Absent seam → 404 (settings/attachments
    // pattern). Session existence is validated here against the coordinator
    // (resume parity) so a stale SPA session id answers 404, not a bridge
    // failure; the conversation/session scoping itself is the bridge's domain
    // (web.ts resolves the session's live-agent registry when one exists).
    if (req.method === "GET" && url.pathname === "/api/commands") {
      if (commandBridge === undefined) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ commands: commandBridge.list() }))
      return
    }
    if (req.method === "POST" && url.pathname === "/api/commands/execute") {
      if (commandBridge === undefined) { res.writeHead(404); res.end(); return }
      const body = await readJsonObject(req, res, "command-invalid")
      if (body === undefined) return
      const request = body as Partial<CommandExecuteRequestWire>
      if (typeof request.sessionId !== "string" || request.sessionId.trim() === ""
        || typeof request.line !== "string" || request.line.trim() === "") {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "sessionId and line are required", code: "command-invalid" }))
        return
      }
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      try {
        await coordinator.load(request.sessionId)
      } catch (error) {
        if (isUnknownSessionError(error)) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: `session not found: ${request.sessionId}` }))
          return
        }
        throw error
      }
      // Cooperative cancellation: abort when the client goes away before the
      // command settles (the command runner may ignore it and finish its own
      // side effects — the bridge contract, like the mux sessionRunner seam).
      const abort = new AbortController()
      res.on("close", () => abort.abort())
      try {
        const result = await commandBridge.run(request.sessionId, request.line, abort.signal)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ result }))
      } catch (error) {
        // Unknown command / handler failure / aborted run: the bridge's error
        // message IS the user-facing failure (the palette surfaces it — no
        // silent drop). 400, never 500: the request was well-formed; the
        // failure belongs to the command semantics.
        const message = error instanceof Error ? error.message : String(error)
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: message, code: "command-failed" }))
      }
      return
    }
    // ── Task 3.1: workspace registry routes (DSH workspace-controller ────────
    // minimal set: create/rename/list + session attach — DSH names kept:
    // create ({ path } → adopt an existing directory, idempotent by path),
    // rename (unique non-blank title), list. Optional seam: absent →
    // 404 (API-only embedders unchanged) — the settings/attachments pattern.
    // DEFERRED (controller ruling 1): DELETE /api/workspaces/:id,
    // workspace reorder (insertBefore), session reorder (insertSessionBefore),
    // follow-stream — the DELETE route is intentionally NOT routed so it
    // answers the generic JSON 404; the registry's seam comments mark exactly
    // which DSH verb would slot in. Task 3.2 already slotted in archiveSession
    // (the registry-global archived set; its routes are the session-scoped
    // POST /api/sessions/:id/[un]archive below). WorkspaceListValue shape is
    // DSH-complete: `archivedSessionIds` rides on the list response.
    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      if (workspaceRegistry === undefined) { res.writeHead(404); res.end(); return }
      const workspaces = await workspaceRegistry.list()
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ workspaces, archivedSessionIds: await workspaceRegistry.archivedSessionIds() }))
      return
    }
    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      if (workspaceRegistry === undefined) { res.writeHead(404); res.end(); return }
      const body = await readJsonObject(req, res, "workspace-invalid-path")
      if (body === undefined) return
      if (typeof body.path !== "string" || body.path.trim() === "") {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "path is required", code: "workspace-invalid-path" }))
        return
      }
      // Ruling 2: create = adopt an EXISTING directory (no OS picker, no
      // mkdir — the frontend types/pastes a path). Canonicalize + verify
      // before registering so a typo never records a dead workspace.
      let canonical: string
      try {
        canonical = await realpath(body.path.trim())
        if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory")
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: `workspace path is not an existing directory: ${body.path}`,
          code: "workspace-invalid-path",
        }))
        return
      }
      try {
        const { workspace, created } = await workspaceRegistry.create(canonical)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ workspace, created }))
      } catch (error) {
        if (error instanceof WorkspaceInvalidPathError) {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: error.message, code: error.code }))
          return
        }
        throw error
      }
      return
    }
    const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/)
    if (req.method === "PUT" && workspaceMatch) {
      if (workspaceRegistry === undefined) { res.writeHead(404); res.end(); return }
      const workspaceId = decodeURIComponent(workspaceMatch[1]!)
      try {
        const body = await readJsonObject(req, res, "bad-request")
        if (body === undefined) return
        const workspace = await workspaceRegistry.rename(workspaceId, String(body.title ?? ""))
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ workspace }))
      } catch (error) {
        // DSH error-code mapping: bad-request → 400, not-found → 404,
        // name-conflict → 409 (the registry throws these typed errors).
        const status = error instanceof WorkspaceNotFoundError ? 404
          : error instanceof WorkspaceNameConflictError ? 409
            : error instanceof WorkspaceBadRequestError ? 400
              : undefined
        if (status !== undefined) {
          res.writeHead(status, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: (error as Error).message, code: (error as { code?: string }).code }))
          return
        }
        throw error
      }
      return
    }
    // ── Task 5.4b: file references (DSH `fileReferences.list` parity, ────────
    // minimal) — GET /api/workspaces/:id/files?q=<substr> → { files } over the
    // embedder-owned FileReferencesBridge (the walk itself lives in
    // @i-harness/workspace; web.ts composes id→path→walk). Optional seam:
    // absent → 404 (every API-only embedder behaves exactly as before). The
    // route owns the transport errors only: unknown workspace → 404 (the
    // registry's lifetime is the host's business), malformed id or over-long
    // query → 400 (client bug, never a silent truncation), walker failures →
    // 500 via the generic route catch.
    const workspaceFilesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/files$/)
    if (req.method === "GET" && workspaceFilesMatch) {
      if (fileReferences === undefined) { res.writeHead(404); res.end(); return }
      let workspaceId: string
      try {
        workspaceId = decodeURIComponent(workspaceFilesMatch[1]!)
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid workspace id" }))
        return
      }
      const query = url.searchParams.get("q") ?? ""
      if (query.length > MAX_FILE_QUERY_LENGTH) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: `query must be at most ${MAX_FILE_QUERY_LENGTH} characters`,
          code: "bad-request",
        }))
        return
      }
      try {
        const files = await fileReferences.list(workspaceId, query)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ files }))
      } catch (error) {
        if (error instanceof WorkspaceNotFoundError) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: error.message, code: error.code }))
          return
        }
        throw error
      }
      return
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const ids = await coordinator.list()
      // Task 3.1: session rows carry workspace grouping derived from the
      // registry doc (session → workspaceId join; the doc is the cheap
      // bookkeeping side of SessionMeta.workspaceId) plus `running`, derived
      // from the attachLiveSession registry (a live agent exists for the
      // session in THIS server process — honest 运行态 marker; never persisted,
      // never a SessionEvent). `running` is reported whether or not the
      // workspace seam is composed; workspaceId only when it is.
      //
      // Task 3.2 meta search (session/search — title/id filter, NOT the 1.2
      // content-FTS endpoint): `?q=` filters rows by case-insensitive
      // substring on title or id; the title metadata itself lands here too
      // (`title`, DSH list parity) together with `blank` (no turn/start yet —
      // DSH list definition, jsonl probed under the DSH cold-probe cap) and
      // `origin`/`archived` (DSH listFields + registry archive set).
      let workspaceBySession: Map<string, string> | undefined
      let archivedSet: Set<string> | undefined
      if (workspaceRegistry !== undefined) {
        workspaceBySession = new Map()
        for (const workspace of await workspaceRegistry.list()) {
          for (const sessionId of workspace.sessionIds) {
            workspaceBySession.set(sessionId, workspace.workspaceId)
          }
        }
        archivedSet = new Set(await workspaceRegistry.archivedSessionIds())
      }
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase()
      const rows: Array<Record<string, unknown>> = []
      // Profile per session (header-only read on jsonl) — settled per row so a
      // single corrupt/missing file never fails the whole list, and the row is
      // still SERVED (never silently hidden): the failure is loud in the log.
      const profiles = await Promise.allSettled(ids.map(id => coordinator.profile(id)))
      profiles.forEach((profile, index) => {
        const id = ids[index]!
        let meta: SessionMeta | undefined
        let blank: boolean | undefined
        if (profile.status === "rejected") {
          console.warn(`[i-harness] session list: profile for "${id}" failed: ${String(profile.reason)}`)
        } else {
          meta = profile.value.meta
          blank = profile.value.blank
          if (query !== "") {
            const hay = `${meta.title ?? ""} ${id}`.toLowerCase()
            if (!hay.includes(query)) return
          }
        }
        rows.push({
          id,
          // R-C0: an attached live instance OR a live service assembly means the
          // session is running in THIS server process (honest 运行态 marker).
          running: liveSessions.has(id) || (executor?.hasAssembly(id) ?? false),
          ...(meta?.title !== undefined ? { title: meta.title } : {}),
          ...(meta?.origin !== undefined ? { origin: meta.origin } : {}),
          // Task 5: the per-session model override surfaces on the list row
          // (header-projected like title/origin) — the composer seat's durable
          // source for "当前 session 生效模型" without a full event read.
          ...(meta?.modelSelection !== undefined ? { modelSelection: meta.modelSelection } : {}),
          ...(blank !== undefined ? { blank } : {}),
          ...(workspaceBySession?.has(id) ? { workspaceId: workspaceBySession.get(id) } : {}),
          ...(archivedSet?.has(id) ? { archived: true } : {}),
        })
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ sessions: rows }))
      return
    }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const body = await readJsonObject(req, res, "bad-request")
      if (body === undefined) return
      // Meta passthrough is unchanged for every key EXCEPT `cwd` (consumed
      // below, never written to the header — it was previously spread into
      // the header as garbage) and `workspaceId` (set ONLY from the resolved
      // workspace below; a non-string/blank body value is never written).
      // The CLI's parentSession passthrough keeps working.
      const meta: Record<string, unknown> = { ...body }
      delete meta.cwd
      // WorkspaceId is NEVER passthrough: without the seam it must not leak
      // into the session header as a dangling reference (the registry doc is
      // the only membership source at list time) — same treatment as cwd.
      delete meta.workspaceId
      let attachedWorkspaceId: string | undefined
      if (workspaceRegistry !== undefined) {
        if (typeof body.workspaceId === "string" && body.workspaceId !== "") {
          // Explicit workspace → must exist (404 otherwise), then attach.
          const workspace = await workspaceRegistry.get(body.workspaceId)
          if (workspace === undefined) {
            res.writeHead(404, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: `workspace not found: ${body.workspaceId}` }))
            return
          }
          meta.workspaceId = workspace.workspaceId
          attachedWorkspaceId = workspace.workspaceId
        } else if (typeof body.cwd === "string" && body.cwd.trim() !== "") {
          // Auto-record (ruling 2): the workspace is created/resolved from
          // the cwd the first time a session is created with it — create =
          // adopt the existing directory, idempotent.
          let canonical: string
          try {
            canonical = await realpath(body.cwd.trim())
            if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory")
          } catch {
            res.writeHead(400, { "content-type": "application/json" })
            res.end(JSON.stringify({
              error: `workspace path is not an existing directory: ${body.cwd}`,
              code: "workspace-invalid-path",
            }))
            return
          }
          const { workspace } = await workspaceRegistry.create(canonical)
          meta.workspaceId = workspace.workspaceId
          attachedWorkspaceId = workspace.workspaceId
        }
        // workspaceRegistry absent → cwd/workspaceId ignored (backward
        // compatible: pre-3.1 embedders behave exactly as before).
      }
      // Two independent awaited steps (review note): create() then
      // attachSession(). A failure BETWEEN them leaves the session header with
      // a workspaceId the doc does not account (never the reverse; sessions
      // are never deleted). The frontend's grouping falls such a session into
      // the 未分配 fallback group, so the gap is visible but not destructive.
      const { id } = await coordinator.create(meta as { sessionId?: string })
      if (attachedWorkspaceId !== undefined) {
        await workspaceRegistry!.attachSession(attachedWorkspaceId, id)
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id }))
      return
    }
    // ── Task 3.2: session management (rename / fork / archive + list meta) ──
    // PUT /api/sessions/:id  body { title } → { title }. DSH session-title
    // semantics simplified: the title is NOT a `session/title` log event
    // (SessionEvent is additive-only — ruled out; a rename is a metadata
    // rewrite, not a log operation) but SessionMeta.title — jsonl header line
    // (atomic temp+rename) / sqlite sessions.title column — written through
    // coordinator.updateMeta. Validation REJECTS invalid titles (400,
    // DSH 'title-invalid' code); DSH's normalize silently cleans/truncates —
    // that is exactly the silent-drop class we do not repeat.
    const sessionMetaMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === "PUT" && sessionMetaMatch) {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(sessionMetaMatch[1]!)
      const body = await readJsonObject(req, res, "title-invalid")
      if (body === undefined) return
      const normalized = normalizeSessionTitle(body.title)
      if (!normalized.ok) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: normalized.message, code: "title-invalid" }))
        return
      }
      try {
        const meta = await coordinator.updateMeta(id, { title: normalized.title })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ title: meta.title }))
      } catch (error) {
        if (isUnknownSessionError(error)) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: `session not found: ${id}` }))
          return
        }
        throw error
      }
      return
    }
    // POST /api/sessions/:id/fork  body { atSeq?, title?, workspaceId? } →
    // { id, seedLength, title? }. DSH fork-from-completed-turn-prefix mapped to
    // OUR log: a new session whose event log is the source's prefix up to the
    // chosen completed turn boundary. Boundary = the first turn/end with
    // seq >= atSeq (atSeq absent or beyond the log → the LAST turn/end); cut
    // stops at the next turn/start (a seed is a whole list of COMPLETED turns,
    // never a half turn — DSH parity exactly). Lineage: parentSession +
    // seedLength in the child header (already supported by SessionMeta /
    // jsonl + sqlite — no new SessionEvent type). Workspace attach: explicit
    // workspaceId wins, else the source's registry workspace (DSH
    // forkWorkspace direct-account resolution simplified — no ancestor
    // lineage walk; that needs the 1.2 session-query lineage seam).
    const forkMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/fork$/)
    if (req.method === "POST" && forkMatch) {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const sourceId = decodeURIComponent(forkMatch[1]!)
      const body = await readJsonObject(req, res, "bad-request")
      if (body === undefined) return
      if (body.atSeq !== undefined
        && (!Number.isInteger(body.atSeq) || (body.atSeq as number) < 0)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "atSeq must be a non-negative integer" }))
        return
      }
      let childTitle: string | undefined
      if (body.title !== undefined) {
        const normalized = normalizeSessionTitle(body.title)
        if (!normalized.ok) {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: normalized.message, code: "title-invalid" }))
          return
        }
        childTitle = normalized.title
      }
      let source: Session
      try {
        source = (await coordinator.load(sourceId)).session
      } catch (error) {
        if (isUnknownSessionError(error)) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: `session not found: ${sourceId}` }))
          return
        }
        throw error
      }
      // m26's load() returns the session only — the header metadata (fork
      // title inheritance) reads through profile() (C5).
      const sourceTitle = (await coordinator.profile(sourceId)).meta.title
      const events = source.events
      // Seq == index for our persisted logs (append() stamps seq =
      // events.length; jsonl is append-only and dense), so the boundary can be
      // located by index; the events[].seq fallback keeps legacy seq-less rows
      // anchored to their position.
      const atSeq = body.atSeq as number | undefined
      let boundaryIdx = -1
      if (atSeq === undefined) {
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i]!.type === "turn/end") { boundaryIdx = i; break }
        }
      } else {
        for (let i = 0; i < events.length; i++) {
          if (events[i]!.type === "turn/end" && (events[i]!.seq ?? i) >= atSeq) { boundaryIdx = i; break }
        }
        if (boundaryIdx === -1 && atSeq > events.length - 1) {
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i]!.type === "turn/end") { boundaryIdx = i; break }
          }
        }
      }
      if (boundaryIdx === -1) {
        // DSH fork-unavailable (409): the failure mode is NOT a 404 — the
        // session exists; its log has no completed turn to fork from.
        res.writeHead(409, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: atSeq !== undefined && atSeq <= events.length - 1
            ? `session "${sourceId}" has not completed the turn containing event ${String(atSeq)}`
            : `session "${sourceId}" has no completed turn to fork from`,
          code: "fork-unavailable",
        }))
        return
      }
      let cut = boundaryIdx + 1
      while (cut < events.length && events[cut]!.type !== "turn/start") cut++
      const prefix = events.slice(0, cut)
      let childWorkspaceId: string | undefined
      if (workspaceRegistry !== undefined) {
        if (typeof body.workspaceId === "string" && body.workspaceId !== "") {
          const workspace = await workspaceRegistry.get(body.workspaceId)
          if (workspace === undefined) {
            res.writeHead(404, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: `workspace not found: ${body.workspaceId}` }))
            return
          }
          childWorkspaceId = workspace.workspaceId
        } else {
          // Inherit the source's workspace (registry join — the same authority
          // the list route uses; the header workspaceId is not authoritative,
          // sqlite does not persist it).
          for (const workspace of await workspaceRegistry.list()) {
            if (workspace.sessionIds.includes(sourceId)) { childWorkspaceId = workspace.workspaceId; break }
          }
        }
      }
      const titleForChild = childTitle ?? sourceTitle
      const { id: childId } = await coordinator.create({
        ...(titleForChild !== undefined ? { title: titleForChild } : {}),
        ...(childWorkspaceId !== undefined ? { workspaceId: childWorkspaceId } : {}),
        parentSession: sourceId,
        seedLength: cut,
      })
      if (prefix.length > 0) await coordinator.append(childId, prefix)
      if (childWorkspaceId !== undefined) {
        try {
          await workspaceRegistry!.attachSession(childWorkspaceId, childId)
        } catch (error) {
          // DSH mapping: the child EXISTS (created + seeded); the attach
          // failure is its own error, reported loudly (never a silent
          // unaccounted row nor a retry-masked 500).
          res.writeHead(500, { "content-type": "application/json" })
          res.end(JSON.stringify({
            error: `session "${childId}" was forked but could not attach to workspace "${childWorkspaceId}": ${String(error)}`,
            code: "workspace-attach-failed",
          }))
          return
        }
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: childId,
        ...(titleForChild !== undefined ? { title: titleForChild } : {}),
        seedLength: cut,
      }))
      return
    }
    // POST /api/sessions/:id/archive → { archivedSessionIds } (DSH
    // workspace.archiveSession: the registry-GLOBAL archive set — a display
    // layer over workspace accounting; the session keeps its workspace slot,
    // the frontend groups it into 已存檔). DSH rejection parity: an unknown
    // session id → 404 session-not-found (fail-loud, never a dangling id in a
    // display set). POST /api/sessions/:id/unarchive is our DELIBERATE
    // extension — DSH has no restore verb, but a one-way hide is a footgun.
    const archiveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/)
    if (req.method === "POST" && archiveMatch) {
      if (workspaceRegistry === undefined) { res.writeHead(404); res.end(); return }
      const id = decodeURIComponent(archiveMatch[1]!)
      try {
        const archivedSessionIds = await workspaceRegistry.archiveSession(id)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ archivedSessionIds }))
      } catch (error) {
        if (error instanceof WorkspaceUnknownSessionError) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: error.message, code: "session-not-found" }))
          return
        }
        throw error
      }
      return
    }
    const unarchiveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/unarchive$/)
    if (req.method === "POST" && unarchiveMatch) {
      if (workspaceRegistry === undefined) { res.writeHead(404); res.end(); return }
      const id = decodeURIComponent(unarchiveMatch[1]!)
      const archivedSessionIds = await workspaceRegistry.unarchiveSession(id)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ archivedSessionIds }))
      return
    }
    // ── Task 1.2: session-query search + lineage endpoints ─────────────────
    // Backed by the optional `sessionQuery` seam (@i-harness/session-query over
    // the SQLite backend's events_fts). The default jsonl backend has no FTS
    // index, so the seam is absent and BOTH endpoints answer the same explicit
    // "not enabled" shape — HTTP 409 + { error, code: "search_not_enabled" } —
    // which the frontend detects by `code` and renders 提示未启用 + the sqlite
    // hint (task 1.2 brief). This is the v1 documented contract; keep it.
    const searchNotEnabled = (res: ServerResponse): void => {
      res.writeHead(409, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "搜索未启用", code: "search_not_enabled" }))
    }
    // GET /api/sessions/search?q=...&sessionId=..&subtreeOf=..&limit=N →
    // { hits: SearchHit[] } (SearchHit: { sessionId, seq, eventType, time?,
    // snippet, bm25 } — exactly what session-query returns, no invented fields).
    if (req.method === "GET" && url.pathname === "/api/sessions/search") {
      if (sessionQuery === undefined) { searchNotEnabled(res); return }
      const q = url.searchParams.get("q")
      if (q === null || q.trim() === "") {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "missing q" }))
        return
      }
      const limitParam = url.searchParams.get("limit")
      if (limitParam !== null && !Number.isInteger(Number(limitParam))) {
        // session-query throws for non-integers (would surface as a 500);
        // out-of-range integers are clamped inside (1..100).
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid limit" }))
        return
      }
      const sessionIdParam = url.searchParams.get("sessionId")
      const subtreeParam = url.searchParams.get("subtreeOf")
      const hits = await sessionQuery.search(q, {
        ...(sessionIdParam !== null ? { sessionId: sessionIdParam } : {}),
        ...(subtreeParam !== null ? { subtreeOf: subtreeParam } : {}),
        ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ hits }))
      return
    }
    // GET /api/sessions/:id/lineage?direction=ancestors|descendants|children[&depth=N]
    // → { nodes: LineageNode[] } (exactly session-query's LineageNode surface).
    const lineageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/lineage$/)
    if (req.method === "GET" && lineageMatch) {
      if (sessionQuery === undefined) { searchNotEnabled(res); return }
      const id = decodeURIComponent(lineageMatch[1]!)
      const direction = url.searchParams.get("direction")
      if (direction !== "ancestors" && direction !== "descendants" && direction !== "children") {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "direction must be one of: ancestors, descendants, children" }))
        return
      }
      const depthParam = url.searchParams.get("depth")
      let depthOpt: { depth: number } | undefined
      if (depthParam !== null) {
        const depth = Number(depthParam)
        if (!Number.isInteger(depth) || depth < 1) {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "invalid depth" }))
          return
        }
        depthOpt = { depth }
      }
      try {
        const nodes = await sessionQuery.lineage(id, { direction, ...(depthOpt ?? {}) })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ nodes }))
        return
      } catch (err) {
        // session-query throws `unknown session: <id>` for ids never created;
        // surface it as a 404 (resume/events route parity) instead of a 500.
        const message = err instanceof Error ? err.message : String(err)
        if (message.startsWith("unknown session:")) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: message }))
          return
        }
        throw err
      }
    }
    // ── Task 1.3: attachment upload + bytes-back retrieval ───────────────────
    // Backed by the optional `attachments` seam (@i-harness/attachment store,
    // bytes under `<workspace>/.i-harness/attachments/att-<uuid>.bin`). The
    // HTTP layer validates uploads with core-session's OWN ImageInput rules
    // (exported constants: media type set, canonical base64, byte limits) so a
    // browser upload obeys the same capacity rules as images appended to a
    // session log; the store's save() re-checks per-image size before any
    // write (an embedder may tune the store limits tighter, in which case the
    // store's validation message surfaces as a 400/413, not a 500). Absent
    // seam → both routes 404 (API-only embedder unchanged).
    //
    // POST /api/attachments  body: { mediaType, dataBase64, name? } (canonical
    // base64 — ImageInput shape for inline data) → 200 { attachmentId,
    // mediaType, bytes, name? } — the store's ImageAttachmentRef surface,
    // nothing invented.
    if (req.method === "POST" && url.pathname === "/api/attachments") {
      if (attachments === undefined) { res.writeHead(404); res.end(); return }
      // Bound the RAW body before parsing: the decoded-size check below only
      // runs after JSON.parse, so a hostile client must not be able to force a
      // giant in-memory parse (base64 is 4/3 × bytes, so 2× the image cap plus
      // JSON overhead is generous).
      const declaredLength = Number(req.headers["content-length"] ?? "0")
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES_PER_MESSAGE * 2) {
        res.writeHead(413, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `payload too large (content-length ${declaredLength})` }))
        return
      }
      const body = await readJsonObject(req, res)
      if (body === undefined) return
      const mediaType = body.mediaType
      if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.has(mediaType as ImageMediaType)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `unsupported media type: ${String(mediaType)}` }))
        return
      }
      const dataBase64 = body.dataBase64
      if (typeof dataBase64 !== "string" || !isValidCanonicalBase64(dataBase64)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "dataBase64 must be canonical base64 (no data: prefix, no whitespace)" }))
        return
      }
      const bytes = imageBase64ByteLength(dataBase64)
      if (bytes > MAX_IMAGE_BYTES_PER_MESSAGE) {
        res.writeHead(413, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `image too large: ${bytes} bytes > ${MAX_IMAGE_BYTES_PER_MESSAGE}` }))
        return
      }
      let ref: ImageAttachmentRef
      try {
        ref = await attachments.save({
          data: Uint8Array.from(Buffer.from(dataBase64, "base64")),
          mediaType: mediaType as ImageMediaType,
          ...(typeof body.name === "string" ? { name: body.name } : {}),
        })
      } catch (err) {
        // The pre-checks above mirror core-session, but an embedder-provided
        // store may enforce TIGHTER limits — map its validation throws to the
        // same client-error shapes instead of a 500 (the failing write path).
        const message = err instanceof Error ? err.message : String(err)
        if (message.startsWith("attachment: image too large")) {
          res.writeHead(413, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: message }))
          return
        }
        if (message.startsWith("attachment: unsupported media type")) {
          res.writeHead(400, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: message }))
          return
        }
        throw err
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        ...(ref.name !== undefined ? { name: ref.name } : {}),
      }))
      return
    }
    // GET /api/attachments/:id?mediaType=<type> → the stored bytes with that
    // content-type (the store keeps bytes ONLY — no mime sidecar, no filename
    // extension — so the mime is supplied by the caller, who knows it from the
    // upload response or the session event's ImageInput; the wrapper above
    // validates it against the same supported set).
    const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/)
    if (req.method === "GET" && attachmentMatch) {
      if (attachments === undefined) { res.writeHead(404); res.end(); return }
      let id: string
      try {
        id = decodeURIComponent(attachmentMatch[1]!)
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid attachment id" }))
        return
      }
      if (!ATTACHMENT_ID_RE.test(id)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `attachment not found: ${id}` }))
        return
      }
      const mediaType = url.searchParams.get("mediaType")
      if (mediaType === null || !IMAGE_MEDIA_TYPES.has(mediaType as ImageMediaType)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "mediaType must be one of: image/png, image/jpeg, image/webp, image/gif" }))
        return
      }
      try {
        // The store's load() reads only attachmentId+mediaType (bytes is the
        // save metadata); the caller fills the known fields.
        const img = await attachments.load({ attachmentId: id, mediaType: mediaType as ImageMediaType, bytes: 0 })
        const body = Buffer.from(img.dataBase64, "base64")
        res.writeHead(200, { "content-type": mediaType, "content-length": String(body.length) })
        res.end(body)
      } catch (err) {
        // Unknown/missing file → 404 (resume/lineage parity), never a 500.
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: `attachment not found: ${id}` }))
          return
        }
        throw err
      }
      return
    }
    const resumeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/)
    if (req.method === "POST" && resumeMatch) {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(resumeMatch[1]!)
      // Resume = validate the session is loadable; live streams are opened
      // over the mux afterwards. Unloadable/unknown id → 404.
      try {
        await coordinator.load(id)
      } catch {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `session not found: ${id}` }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ id }))
      return
    }
    const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)
    if (req.method === "GET" && eventsMatch) {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(eventsMatch[1]!)
      // Query validation (review MUST-FIX): `Number("abc")` is NaN, which used
      // to reach `slice(-NaN)` (=== `slice(0)` → the WHOLE log). Non-finite /
      // sub-1 limits fall back to the default inside paginateEvents (which
      // also clamps the page size); a non-numeric beforeSeq is ignored —
      // treated as absent rather than rejected.
      const limitParam = url.searchParams.get("limit")
      const beforeParam = url.searchParams.get("beforeSeq")
      // C2 (afterSeq forward replay): a non-numeric afterSeq is REJECTED here
      // (the client should notice its cursor is broken — the fold stays
      // permissive but the route never pretends NaN is a cursor); both
      // cursors together are a client bug (400 events-cursor-invalid).
      const afterParam = url.searchParams.get("afterSeq")
      if (beforeParam !== null && afterParam !== null) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "beforeSeq and afterSeq are mutually exclusive", code: "events-cursor-invalid" }))
        return
      }
      if (afterParam !== null && !Number.isFinite(Number(afterParam))) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "afterSeq must be a number", code: "events-cursor-invalid" }))
        return
      }
      const { session } = await coordinator.load(id)
      const page = paginateEvents(session, {
        ...(limitParam !== null ? { limit: Number(limitParam) } : {}),
        ...(beforeParam !== null && Number.isFinite(Number(beforeParam))
          ? { beforeSeq: Number(beforeParam) }
          : {}),
        ...(afterParam !== null
          ? { afterSeq: Number(afterParam) }
          : {}),
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(page))
      return
    }
    // ── Task 4.2: goals (DSH goal parity simplified) ────────────────────────
    // GET /api/sessions/:id/goal → { goal: GoalView | null } (null until the
    // first create and after a clear tombstone). The projection is folded
    // from the session log: no separate state store.
    const goalMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/goal$/)
    if (goalMatch && req.method === "GET") {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(goalMatch[1]!)
      try {
        const session = await sessionForGoal(id)
        const view: GoalView | null = foldGoal(session.events)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ goal: view }))
        return
      } catch (error) {
        if (isUnknownSessionError(error)) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: `session not found: ${id}` }))
          return
        }
        throw error
      }
    }
    // POST /api/sessions/:id/goal  body { objective, maxGoalRounds? } →
    // create + arm (active). A completed goal may be replaced (DSH parity);
    // any other current phase must be cleared/resumed first (409 goal-exists).
    if (goalMatch && req.method === "POST") {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(goalMatch[1]!)
      const body = await readGoalBody(req, res)
      if (body === undefined) return
      await settleGoalMutation(res, id, "create", body)
      return
    }
    // PUT /api/sessions/:id/goal  body { ref, objective?, maxGoalRounds? } →
    // edit without changing phase. Only edits the provided fields; a ref
    // conflict (409 goal-stale-ref) means the frontend refreshes + surfaces.
    if (goalMatch && req.method === "PUT") {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(goalMatch[1]!)
      const body = await readGoalBody(req, res)
      if (body === undefined) return
      await settleGoalMutation(res, id, "edit", body)
      return
    }
    // POST /api/sessions/:id/goal/(pause|resume|complete|clear) — the four
    // phase verbs, one route with an action parameter (they share body/error
    // handling; host.ts's per-verb split pattern would duplicate it four
    // times). Each carries the CAS ref; clear answers { goal: null }.
    const goalActionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/goal\/(pause|resume|complete|clear)$/)
    if (goalActionMatch && req.method === "POST") {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(goalActionMatch[1]!)
      const operation = goalActionMatch[2] as Extract<GoalOperation, "pause" | "resume" | "complete" | "clear">
      const body = await readGoalBody(req, res)
      if (body === undefined) return
      await settleGoalMutation(res, id, operation, body)
      return
    }
    // ── Task 4.4: jobs + queue status (jobs 状态流基础版) ─────────────────────
    // GET /api/sessions/:id/jobs → { jobs: JobView[], queue: CommandQueueView }.
    // Jobs source: the subagent layer's DURABLE snapshot doc —
    // coordinator.putDocument(stateId, snapshotState(...)) from
    // @i-harness/subagent (persist.ts), and in this composition the web path
    // registers it with stateId = the session id (apps/cli live-agent.ts), so
    // a session's jobs ARE its doc. The host reads the doc as opaque JSON and
    // maps it structurally (jobs.ts — no @i-harness/subagent dependency); a
    // session that never ran subagents has no doc → { jobs: [] } (honest
    // empty, never an invented store). `queue` carries the per-session busy
    // state (the command-chain observation counter — the only queue that
    // exists; no prompt storage, reorder deferred per the task brief). The
    // live side is the additive `job/status` event streamed over the existing
    // mux session stream (subagent persists append it to the live parent
    // session; the SPA folds it — foldJobs, job/status ↔ JobView).
    const jobsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/jobs$/)
    if (req.method === "GET" && jobsMatch) {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(jobsMatch[1]!)
      try {
        await coordinator.load(id)
      } catch (error) {
        if (isUnknownSessionError(error)) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: `session not found: ${id}` }))
          return
        }
        throw error
      }
      const doc = await coordinator.getDocument(id)
      // A doc under the session key that is NOT a subagent snapshot (foreign/
      // corrupt) must be loud, not silently served: warn + empty list.
      if (doc !== undefined
        && (typeof doc !== "object" || doc === null || !Array.isArray((doc as { jobs?: unknown }).jobs))) {
        console.warn(`[i-harness] jobs route: doc "${id}" is not a subagent snapshot — serving an empty list`)
      }
      const jobs: JobView[] = projectJobsDoc(doc)
      // R-C0: the queue observation now comes from the session service's
      // per-session lane (running + registered-not-started turns) — the host's
      // own command-chain counter is gone (the executor owns serialization).
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jobs, queue: executor?.queueState(id) ?? { running: false, queued: 0 } }))
      return
    }
    // ── Task 5.5: jobs kill (the jobs popover's kill button) ────────────────
    // POST /api/sessions/:id/jobs/:jobId/kill → { outcome }. The bridge is
    // the embedder's live-agent subagent job registry kill — the same
    // machinery the model-facing job_kill tool calls for subagent jobs — and
    // its persistent wrapper both appends the additive `job/status` event to
    // the live session (the SPA's realtime fold) and persists the durable
    // snapshot doc (the next GET /jobs shows the new status). Unknown job id
    // → 409 (honest: nothing to kill), unknown session → 404, absent bridge
    // → 404 (optional seam — the settings/commands route semantics).
    const jobKillMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/jobs\/([^/]+)\/kill$/)
    if (req.method === "POST" && jobKillMatch) {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(jobKillMatch[1]!)
      const jobId = decodeURIComponent(jobKillMatch[2]!)
      try {
        await coordinator.load(id)
      } catch (error) {
        if (isUnknownSessionError(error)) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: `session not found: ${id}` }))
          return
        }
        throw error
      }
      if (jobKillBridge === undefined) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "jobs kill endpoint not configured" }))
        return
      }
      try {
        const outcome = await jobKillBridge.kill(id, jobId)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ outcome }))
        return
      } catch (error) {
        if (error instanceof JobKillUnknownJobError) {
          res.writeHead(409, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: error.message }))
          return
        }
        throw error
      }
    }
    // ── Task 4.3: message feedback (DSH message-feedback parity simplified) ─
    // Endpoints (feedback.ts owns the store, validation and CAS; the host owns
    // the HTTP transport + error-code mapping):
    //   GET    /api/sessions/:id/feedback             → { items } (200)
    //   PUT    /api/sessions/:id/feedback             { messageId, rating,
    //          note?, ifVersion? }                    → { item } (200 upsert)
    //   DELETE /api/sessions/:id/feedback/:messageId?ifVersion=N → { absent: true }
    // CAS: per-item integer version. A put WITHOUT ifVersion overwrites
    // unconditionally; a provided version that mismatches → 409 version-conflict
    // (carries `current` so the SPA can reconcile — the goal/DSH posture:
    // refresh + surface, never a silent drop). delete carries ifVersion purely
    // as a query parameter (no body on DELETE — the simplest honest CAS).
    // Errors: feedback-invalid / note-blank / note-too-large / message-not-found
    // → 400 (client bugs), version-conflict → 409, unknown session → 404.
    const forwardFeedbackError = (res: ServerResponse, error: unknown, sessionId: string): boolean => {
      if (error instanceof FeedbackBadRequestError
        || error instanceof FeedbackNoteEmptyError
        || error instanceof FeedbackNoteTooLargeError
        || error instanceof FeedbackMessageNotFoundError) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: (error as Error).message, code: (error as { code: string }).code }))
        return true
      }
      if (error instanceof FeedbackVersionConflictError) {
        res.writeHead(409, { "content-type": "application/json" })
        // `current` is always carried (null = the target item is absent — the
        // client then knows a create would win, DSH version-conflict parity).
        res.end(JSON.stringify({ error: error.message, code: error.code, current: error.current ?? null }))
        return true
      }
      if (isUnknownSessionError(error)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `session not found: ${sessionId}` }))
        return true
      }
      return false
    }
    const feedbackMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/feedback$/)
    if (req.method === "GET" && feedbackMatch) {
      if (feedbackStore === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(feedbackMatch[1]!)
      try {
        const { items } = await feedbackStore.list(id)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ items }))
      } catch (error) {
        if (forwardFeedbackError(res, error, id)) return
        throw error
      }
      return
    }
    if (req.method === "PUT" && feedbackMatch) {
      if (feedbackStore === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(feedbackMatch[1]!)
      const body = await readJsonObject(req, res, "feedback-invalid")
      if (body === undefined) return
      const request = body as Partial<MessageFeedbackPutRequest>
      try {
        const { item } = await feedbackStore.put(id, {
          messageId: request.messageId as string,
          rating: request.rating as MessageFeedbackPutRequest["rating"],
          ...(request.note !== undefined ? { note: request.note as string } : {}),
          ...(request.ifVersion !== undefined ? { ifVersion: request.ifVersion as number } : {}),
        })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ item }))
      } catch (error) {
        if (forwardFeedbackError(res, error, id)) return
        throw error
      }
      return
    }
    const feedbackItemMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/feedback\/([^/]+)$/)
    if (req.method === "DELETE" && feedbackItemMatch) {
      if (feedbackStore === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(feedbackItemMatch[1]!)
      const messageId = decodeURIComponent(feedbackItemMatch[2]!)
      const rawIfVersion = url.searchParams.get("ifVersion")
      // An explicit-but-empty ifVersion is a malformed request, never a
      // silent "force" (the client meant to CAS — surface the bug as 400).
      if (rawIfVersion !== null && rawIfVersion === "") {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "ifVersion 必须是非负整数", code: "feedback-invalid" }))
        return
      }
      const ifVersion = rawIfVersion === null ? undefined : Number(rawIfVersion)
      try {
        const result = await feedbackStore.delete(id, messageId, ifVersion)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(result))
      } catch (error) {
        if (forwardFeedbackError(res, error, id)) return
        throw error
      }
      return
    }
    // ── Task 6: plugins (DSH/Claude marketplace over our HTTP idiom) ─────────
    // Optional seam: absent → every /api/plugins route answers 404, so an
    // embedder without plugin support behaves exactly as before (settings/
    // commands seam pattern). The host is transport-only: it maps the
    // registry's typed errors (forwardPluginRegistryError) and passes the
    // seam's own wire views through verbatim — it never touches the registry
    // internals or the evaluator. No immediate events: mutations answer
    // 200 {} and the SPA refetches (repo preferences convention).
    if (req.method === "GET" && url.pathname === "/api/plugins/catalog") {
      if (pluginRegistry === undefined) { res.writeHead(404); res.end(); return }
      const view = await pluginRegistry.catalog()
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(view))
      return
    }
    if (req.method === "GET" && url.pathname === "/api/plugins/runtime") {
      if (pluginRegistry === undefined) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ plugins: pluginRegistry.runtime() }))
      return
    }
    // POST /api/plugins/source { source } → 200 {} (the SPA refetches the
    // catalog afterwards). Source is required — a blank/missing source is a
    // client bug (400, never a silent skip); the registry does the trimming
    // and the 4-form resolution.
    if (req.method === "POST" && url.pathname === "/api/plugins/source") {
      if (pluginRegistry === undefined) { res.writeHead(404); res.end(); return }
      const body = await readJsonObject(req, res, "plugin-source-invalid")
      if (body === undefined) return
      if (typeof body.source !== "string" || body.source.trim() === "") {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "source is required", code: "plugin-source-invalid" }))
        return
      }
      try {
        await pluginRegistry.addSource(body.source)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({}))
      } catch (error) {
        if (forwardPluginRegistryError(res, error)) return
        throw error
      }
      return
    }
    // POST /api/plugins/source/:name/refresh → re-pull one source's manifest.
    const pluginSourceRefreshMatch = url.pathname.match(/^\/api\/plugins\/source\/([^/]+)\/refresh$/)
    if (req.method === "POST" && pluginSourceRefreshMatch) {
      if (pluginRegistry === undefined) { res.writeHead(404); res.end(); return }
      let name: string
      try {
        name = decodeURIComponent(pluginSourceRefreshMatch[1]!)
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid source name" }))
        return
      }
      try {
        await pluginRegistry.refreshSource(name)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({}))
      } catch (error) {
        if (forwardPluginRegistryError(res, error)) return
        throw error
      }
      return
    }
    // DELETE /api/plugins/source/:name → drop a source + its cache copy
    // (already-installed plugins stay).
    const pluginSourceMatch = url.pathname.match(/^\/api\/plugins\/source\/([^/]+)$/)
    if (req.method === "DELETE" && pluginSourceMatch) {
      if (pluginRegistry === undefined) { res.writeHead(404); res.end(); return }
      let name: string
      try {
        name = decodeURIComponent(pluginSourceMatch[1]!)
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid source name" }))
        return
      }
      try {
        await pluginRegistry.removeSource(name)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({}))
      } catch (error) {
        if (forwardPluginRegistryError(res, error)) return
        throw error
      }
      return
    }
    // POST /api/plugins/:id/{install|uninstall|enable|disable} — one action
    // route with the verb in the URL (the goal-action-verb pattern; they
    // share body/error handling so a per-verb split would duplicate it).
    const pluginActionMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/(install|uninstall|enable|disable)$/)
    if (req.method === "POST" && pluginActionMatch) {
      if (pluginRegistry === undefined) { res.writeHead(404); res.end(); return }
      let id: string
      try {
        id = decodeURIComponent(pluginActionMatch[1]!)
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid plugin id" }))
        return
      }
      const action = pluginActionMatch[2]!
      try {
        if (action === "install") await pluginRegistry.install(id)
        else if (action === "uninstall") await pluginRegistry.uninstall(id)
        else if (action === "enable") await pluginRegistry.enable(id)
        else await pluginRegistry.disable(id)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({}))
      } catch (error) {
        if (forwardPluginRegistryError(res, error)) return
        throw error
      }
      return
    }
    // ── Task 4 (models plan): model-sources routes ───────────────────────────
    // Settings sections (describe/mutate), credentials, llm directory/probe and
    // the models catalog over the ModelSources seam (types.ts). Each seam PIECE
    // is optional — a route whose backing piece is absent answers 404, so an
    // API-only embedder without model-settings support behaves exactly as
    // before (settings/commands seam pattern). The host is transport-only:
    // forwardModelsError maps the packages' typed errors, the view shapes pass
    // through verbatim. No immediate events: mutations answer the fresh view
    // and the SPA refetches (repo preferences convention). POST
    // /api/sessions/:id/model (per-session model selection) is Task 5's — the
    // route is registered in the Task 5 block at the end of this section
    // (it is coordinator-owned, so it works without the optional seam).
    if (req.method === "GET" && url.pathname === "/api/settings/sections") {
      const sectionStore = modelSources?.settingsStore
      if (sectionStore === undefined) { res.writeHead(404); res.end(); return }
      const name = url.searchParams.get("name") ?? ""
      if (name !== "llm" && name !== "onboarding" && name !== "core") {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: `unknown settings section: ${JSON.stringify(name)}`,
          code: "settings-section-invalid",
        }))
        return
      }
      // load() first: describeSection reads the store's in-memory snapshot,
      // which is defaults-only until the on-disk document is loaded.
      await sectionStore.load()
      if (name === "core") {
        // The legacy top-level keys view (GET/PUT /api/settings remain the
        // prefs surface): the same document minus the appended sections.
        const value: Record<string, unknown> = { ...sectionStore.get() }
        delete value.llm
        delete value.onboarding
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ section: { name: "core", value, writable: true } }))
        return
      }
      const section = describeSection(name, sectionStore)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ section }))
      return
    }
    if (req.method === "POST" && url.pathname === "/api/settings/mutate") {
      const sectionStore = modelSources?.settingsStore
      if (sectionStore === undefined) { res.writeHead(404); res.end(); return }
      const body = await readJsonObject(req, res, "settings-mutate-invalid")
      if (body === undefined) return
      if (body.name !== "llm" && body.name !== "onboarding") {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: 'name must be "llm" or "onboarding"',
          code: "settings-mutate-invalid",
        }))
        return
      }
      const ops = parseSectionOps(body.ops)
      if (ops === undefined) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: "ops must be an array of {op: \"set\"|\"unset\", path: non-empty string[], value?}",
          code: "settings-mutate-invalid",
        }))
        return
      }
      const expectedRevision = body.expectedRevision
      if (expectedRevision !== undefined
        && (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: "expectedRevision must be a non-negative integer",
          code: "settings-mutate-invalid",
        }))
        return
      }
      try {
        // load() BEFORE mutating: a never-loaded store would write defaults ⊕
        // patch over the on-disk document (the revision guard does not help —
        // the in-memory revision is 0 while the disk content is newer).
        await sectionStore.load()
        const section = await mutateSection(body.name, ops, sectionStore, expectedRevision)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ section }))
      } catch (error) {
        if (forwardModelsError(res, error)) return
        throw error
      }
      return
    }
    if (req.method === "GET" && url.pathname === "/api/credentials") {
      const cs = modelSources?.credentialStore
      if (cs === undefined) { res.writeHead(404); res.end(); return }
      const refsParam = url.searchParams.get("refs")
      const refs = refsParam === null || refsParam === ""
        ? []
        : refsParam.split(",").map((r) => r.trim()).filter((r) => r !== "")
      try {
        const credentials = cs.describe(refs)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ credentials }))
      } catch (error) {
        if (forwardModelsError(res, error)) return
        throw error
      }
      return
    }
    if (req.method === "POST" && url.pathname === "/api/credentials") {
      const cs = modelSources?.credentialStore
      if (cs === undefined) { res.writeHead(404); res.end(); return }
      const body = await readJsonObject(req, res, "credential-invalid-ref")
      if (body === undefined) return
      if (typeof body.ref !== "string" || typeof body.value !== "string") {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "ref and value must be strings", code: "credential-invalid-ref" }))
        return
      }
      const ref = body.ref
      const value = body.value
      try {
        await cs.set(ref, value)
        // One-way describe of the post-write state (the store NEVER echoes the
        // value); env-shadowing was rejected by set, so "file" wins the read.
        const credential = cs.describe([ref])[ref]
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ref, credential }))
      } catch (error) {
        if (forwardModelsError(res, error)) return
        throw error
      }
      return
    }
    const credentialRefMatch = url.pathname.match(/^\/api\/credentials\/([^/]+)$/)
    if (req.method === "DELETE" && credentialRefMatch) {
      const cs = modelSources?.credentialStore
      if (cs === undefined) { res.writeHead(404); res.end(); return }
      let ref: string
      try {
        ref = decodeURIComponent(credentialRefMatch[1]!)
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid credential ref" }))
        return
      }
      try {
        await cs.unset(ref)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ref }))
      } catch (error) {
        if (forwardModelsError(res, error)) return
        throw error
      }
      return
    }
    if (req.method === "GET" && url.pathname === "/api/llm/directory") {
      const registry = modelSources?.providerRegistry
      if (registry === undefined) { res.writeHead(404); res.end(); return }
      // The merged directory: declared seed rows ⊕ the user-section routes
      // (the settings store is an optional piece — absent → seeds only).
      let userProviders: Record<string, unknown> = {}
      const settingsStore = modelSources?.settingsStore
      if (settingsStore !== undefined) {
        await settingsStore.load()
        userProviders = sectionUserProviders(describeSection("llm", settingsStore))
      }
      const directory = mergeDirectoryRows(registry.describeDirectory(), userProviders)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ directory }))
      return
    }
    // ── probe chain shared by POST /api/llm/probe + /api/llm/probe-apply ─────
    /** Shape guard for both probe routes: route is a non-blank string; the
     * draft fields are optional strings. The type predicate narrows the wire
     * body (extra keys pass through harmlessly — readJsonObject already
     * rejected non-objects). */
    function isProbeInput(body: Record<string, unknown>): body is {
      route: string; baseURL?: string; apiKey?: string; protocol?: string
    } {
      return typeof body.route === "string" && body.route.trim() !== ""
        && (body.baseURL === undefined || typeof body.baseURL === "string")
        && (body.apiKey === undefined || typeof body.apiKey === "string")
        && (body.protocol === undefined || typeof body.protocol === "string")
    }

    /** Controller pin (task 7 review — final rule): the probe protocol is
     * resolved CONTROLLER-SIDE, chain = section value > SPA-passed DRAFT >
     * DEFAULT (SEEDED_PROTOCOLS is EMPTY under the amendment — the seeded
     * profiles were removed; the map arm stays as the defensive tail of the
     * same chain for embedded registries). The SPA-passed value is trusted
     * ONLY for a route the user section knows nothing about — the create
     * dialog's UNSAVED draft: the draft already carries its baseURL/apiKey
     * to the same host, so the unsigned (three-value-checked) protocol is
     * unprivileged — and it is the flagship flow (an unsaved anthropic draft
     * MUST probe with x-api-key + anthropic-version, not Bearer). A route
     * the section configures always resolves from the section (the SPA value
     * is discarded there — "never trusted" applies to the configured case);
     * no draft → the generic default.
     * Probe-key chain (bug fix 2): an EXPLICIT (non-empty) draft apiKey wins —
     * the SPA's unsaved key is the first-class probe secret; a saved route
     * (userCfg) with an apiKeyEnv resolves it via the credential store's
     * env>file chain (resolve is the optional seam piece); neither → keyless
     * (an open gateway probes unchanged). The draft baseURL still passes
     * VERBATIM (ROOT convention — nothing is stored by probing). A resolve()
     * rejection (invalid ref) surfaces via the forwardModelsError mapping
     * (credential-invalid-ref → 400).
     * The store is LOADED here (fresh-read for the pre-probe protocol
     * resolution). probe-apply invokes it AGAIN after the probe — the upsert
     * merges against the freshest stored rows, never a pre-probe snapshot. */
    async function resolveProbeChain(body: {
      route: string; baseURL?: string; apiKey?: string; protocol?: string
    }): Promise<{
      userCfg: SettingsProviderConfig | undefined
      protocol: SettingsProviderProtocol
      probeKey: string | undefined
    }> {
      const settingsStore = modelSources?.settingsStore
      let userCfg: SettingsProviderConfig | undefined
      if (settingsStore !== undefined) {
        await settingsStore.load()
        const userProviders = sectionUserProviders(describeSection("llm", settingsStore))
        const raw = userProviders[body.route]
        userCfg = typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as SettingsProviderConfig)
          : undefined
      }
      const isWireProtocol = (value: unknown): value is SettingsProviderProtocol =>
        typeof value === "string" && (PROVIDER_PROTOCOLS as readonly string[]).includes(value)
      const protocol = userCfg !== undefined
        ? resolveProviderProtocol(body.route, userCfg)
        : SEEDED_PROTOCOLS[body.route] !== undefined
          ? resolveProviderProtocol(body.route, undefined)
          : isWireProtocol(body.protocol)
            ? body.protocol
            : DEFAULT_PROVIDER_PROTOCOL
      const probeKey =
        body.apiKey !== undefined && body.apiKey !== ""
          ? body.apiKey
          : userCfg?.apiKeyEnv !== undefined && userCfg.apiKeyEnv !== ""
              && modelSources?.credentialStore?.resolve !== undefined
            ? modelSources.credentialStore.resolve(userCfg.apiKeyEnv)
            : undefined
      return { userCfg, protocol, probeKey }
    }

    if (req.method === "POST" && url.pathname === "/api/llm/probe") {
      const registry = modelSources?.providerRegistry
      if (registry === undefined) { res.writeHead(404); res.end(); return }
      const body = await readJsonObject(req, res, "probe-invalid")
      if (body === undefined) return
      if (!isProbeInput(body)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: "route is required; baseURL/apiKey/protocol must be strings",
          code: "probe-invalid",
        }))
        return
      }
      try {
        const { protocol, probeKey } = await resolveProbeChain(body)
        const models = await registry.probeModels(body.route, {
          ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {}),
          ...(probeKey !== undefined ? { apiKey: probeKey } : {}),
          protocol,
        })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ models }))
      } catch (error) {
        if (forwardModelsError(res, error)) return
        throw error
      }
      return
    }
    if (req.method === "POST" && url.pathname === "/api/llm/probe-apply") {
      const registry = modelSources?.providerRegistry
      const settingsStore = modelSources?.settingsStore
      if (registry === undefined || settingsStore === undefined) { res.writeHead(404); res.end(); return }
      const body = await readJsonObject(req, res, "probe-apply-invalid")
      if (body === undefined) return
      if (!isProbeInput(body)) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: "route is required; baseURL/apiKey/protocol must be strings",
          code: "probe-apply-invalid",
        }))
        return
      }
      try {
        // Spec §2.2: probe FIRST (same controller-side chain as /api/llm/probe);
        // a probe failure keeps settings untouched — never a half-write. The
        // draft apiKey stays in memory only (never persisted, never echoed).
        const { protocol, probeKey } = await resolveProbeChain(body)
        const discovered = await registry.probeModels(body.route, {
          ...(body.baseURL !== undefined ? { baseURL: body.baseURL } : {}),
          ...(probeKey !== undefined ? { apiKey: probeKey } : {}),
          protocol,
        })
        // The probe took time — re-resolve so the upsert merges against the
        // freshest stored rows (a concurrent edit wins, never a pre-probe
        // snapshot).
        const { userCfg } = await resolveProbeChain(body)
        const existing = Array.isArray(userCfg?.models) ? userCfg.models : undefined
        const merged = upsertModelRows(existing, discovered)
        await mutateSection("llm", [
          { op: "set", path: ["providers", body.route, "models"], value: merged },
        ], settingsStore)
        const fingerprint = createHash("sha256")
          .update(body.route).update("\n")
          .update(body.baseURL ?? "").update("\n")
          .update(body.apiKey ?? "")
          .digest("hex")
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          adopted: discovered.length,
          models: discovered,
          fingerprint,
        }))
      } catch (error) {
        if (forwardModelsError(res, error)) return
        throw error
      }
      return
    }
    if (req.method === "GET" && url.pathname === "/api/models/catalog") {
      const sectionStore = modelSources?.settingsStore
      const registry = modelSources?.providerRegistry
      if (sectionStore === undefined || registry === undefined) { res.writeHead(404); res.end(); return }
      await sectionStore.load()
      const catalog = buildModelsCatalog({
        directory: registry.describeDirectory(),
        section: describeSection("llm", sectionStore),
        fallbackDefault: sectionStore.get().llm.defaultModel,
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(catalog))
      return
    }
    // ── Task 5: per-session model selection (the slot Task 4 deferred) ──────
    // POST /api/sessions/:id/model  body { provider, model, reasoningEffort? }
    // → { modelSelection } (200). Writes SessionMeta.modelSelection through
    // coordinator.updateMeta (jsonl: header rewrite via temp+rename with event
    // lines byte-exact; sqlite: updateMeta REFUSES unknown meta keys loudly —
    // model selection is jsonl-supported, sqlite-fail-closed). This route is
    // sessions-scoped + coordinator-owned, so it works WITHOUT the optional
    // model-sources seam (the per-piece 404 rule applies to the settings/
    // credentials/llm routes only). Unknown session → 404. An agent already
    // alive keeps its model (执行中不受影响 — plugin ruling); the selection
    // applies to the session's next agent build via the resolution chain in
    // apps/cli web.ts (session.meta.modelSelection > llm.defaultModel >
    // core.model > mock).
    const sessionModelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/model$/)
    if (req.method === "POST" && sessionModelMatch) {
      if (coordinator === undefined) { res.writeHead(500); res.end(); return }
      const id = decodeURIComponent(sessionModelMatch[1]!)
      const body = await readJsonObject(req, res, "session-model-invalid")
      if (body === undefined) return
      const selection = parseSessionModelSelection(body)
      if (selection === undefined) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({
          error: 'body must be { provider: non-empty string, model: non-empty string, reasoningEffort?: non-empty string }',
          code: "session-model-invalid",
        }))
        return
      }
      try {
        const meta = await coordinator.updateMeta(id, { modelSelection: selection })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ modelSelection: meta.modelSelection }))
      } catch (error) {
        if (isUnknownSessionError(error)) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: `session not found: ${id}` }))
          return
        }
        throw error
      }
      return
    }
    // GET /api/telemetry: deferred (R-C6 keeps the manifest; the surface is
    // out of C-scope) — unmatched routes fall through to the JSON 404.
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  }

  /**
   * Read a request body that MUST be a JSON plain object (every object-body
   * route's contract). Two client failures share the 400 answer:
   * malformed/empty JSON, and syntactically valid JSON that is NOT an object —
   * JSON `null` included (a `null` body previously parsed "fine" and then
   * threw a TypeError on the route's first property read → the generic catch's
   * 500). `undefined` means "already answered": the 400 carries the route's
   * existing `*-invalid` code via `code` (omitted when the route answers
   * body errors without a code — attachment parity). Raw `readJson` stays for
   * callers that legitimately accept non-object bodies (settings PUT spreads a
   * patch, where a JSON `null` is the no-op "no patch" case).
   */
  async function readJsonObject(
    req: IncomingMessage,
    res: ServerResponse,
    code?: string,
  ): Promise<Record<string, unknown> | undefined> {
    const fail = (message: string): undefined => {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: `invalid JSON body: ${message}`, ...(code !== undefined ? { code } : {}) }))
      return undefined
    }
    let value: unknown
    try {
      value = await readJson(req)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return fail(message)
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return fail("expected a plain object")
    }
    return value as Record<string, unknown>
  }

  return {
    attachLiveSession({ sessionId, session }): void {
      liveSessions.set(sessionId, session)
      // C1 (gen-forward rebind): streams ALREADY OPEN on a snapshot bundle —
      // the SPA opens its streams at session-select time, before the first
      // command creates the live agent — must see the live appends. Re-point
      // the cached bundle at the attached instance instead of only evicting
      // it: eviction stranded the open generators on the frozen snapshot
      // (first-turn events lost until reload). New opens still derive from
      // `liveSessions` first; the cache entry stays shared by all of them.
      liveStreams.get(sessionId)?.bundle.reattach(session)
    },
    listen(): Promise<{ port: number }> {
      return new Promise((resolve) => {
        server.listen(opts.port, "127.0.0.1", () => {
          const addr = server.address() as { port: number }
          resolve({ port: addr.port })
        })
      })
    },
    async close(): Promise<void> {
      await mux.close()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // HTTP keep-alive sockets (e.g. undici's fetch pool) never idle out on
        // their own during a test's teardown window — close them so
        // server.close()'s callback fires and close() resolves.
        server.closeIdleConnections()
      })
    },
  }
}
