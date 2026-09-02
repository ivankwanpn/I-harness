// packages/web-host/src/types.ts — wire protocol + embedder seams (R-C1).
// M26 adaptation: the E-region packages are REAL (settings/credentials/
// workspace/plugin-registry/goal/jobs/feedback) — every type below is imported
// from the owning package (one source of truth, no drift). The host is
// transport-only: it never touches the packages' internals.
import type { SessionEvent } from "@i-harness/core-session"
import type { CommandDescriptor } from "@i-harness/interaction"
import type { FileReferenceCandidate } from "@i-harness/workspace"
import type {
  CapabilityStatus,
  CatalogPlugin,
  CommandStatus,
  OverallStatus,
  PluginSourceInfo,
} from "@i-harness/plugin-registry"
import type { CredentialInfo } from "@i-harness/credentials"
import type { SessionModelSelection } from "@i-harness/session-persistence"
import type { DirectoryEntry, ModelDescriptor } from "@i-harness/provider"
import type { SectionView, SettingsStore } from "@i-harness/settings"
import type { JobKillOutcome } from "@i-harness/jobs"
export type { GoalOperation, GoalPhase, GoalRef, GoalSnapshot } from "@i-harness/core-session"
// Task 4 preview-wire types (the PluginsView consumes them via the types-only
// subpath): the catalog/runtime rows ARE the registry's own types — one source
// of truth, no drift.
export type { CapabilityStatus, CatalogPlugin, CommandStatus, OverallStatus, PluginSourceInfo } from "@i-harness/plugin-registry"

// Command descriptor wire shape (task 4.1): exactly @i-harness/interaction's
// discovery view of a registered command (name + optional description, never
// the handler) — nothing invented on the wire.
export type { CommandDescriptor }
// Task 5.4b file-reference candidate wire shape: the @ picker's row is the
// walker's own type (@i-harness/workspace — path/name/type, no drift).
export type { FileReferenceCandidate }
// Task 4.2 goal wire types (the `goal` projection + CAS ref) — the SPA
// re-exports these from the types-only subpath, same as every other protocol
// type: one source of truth, no drift.
export type { GoalView, GoalMutationRequest } from "@i-harness/goal"
// Task 4.4 jobs/queue wire types (jobs 状态流基础版): GET /api/sessions/:id/jobs
// body + the `job/status` fold surface.
export type { JobView, JobsView, JobStatusView, CommandQueueView } from "@i-harness/jobs"
// Task 4.3 message-feedback wire types (the store API is host-internal; the
// SPA consumes these over HTTP only): items carry a per-item CAS `version`;
// a put without `ifVersion` overwrites unconditionally.
export type { MessageFeedbackItem, MessageFeedbackPutRequest, MessageFeedbackRating } from "@i-harness/feedback"
// Task 5.5 jobs-kill outcome vocabulary: re-exported through the types-only
// subpath so the SPA needs no node-bound import for the exact union.
export type { JobKillOutcome } from "@i-harness/jobs"
// Task 4 (models plan) wire types: the SPA consumes them over HTTP only.
// SectionView is @i-harness/settings' own describe view; CredentialInfo /
// DirectoryEntry / ModelDescriptor are the credentials and provider packages'
// own record types — the host never invents an intermediate shape.
export type { CredentialInfo }
export type { DirectoryEntry, ModelDescriptor }
export type { SectionView }
// Task 5 per-session model selection wire shape: POST /api/sessions/:id/model
// body + response / the session list row's `modelSelection` are the
// session-persistence package's own record type — one source of truth.
export type { SessionModelSelection }
export type {
  ModelsCatalogView,
  CatalogDefault,
  CatalogGroup,
  CatalogModel,
  CatalogFailure,
  ProviderDirectoryRow,
  UserProviderView,
} from "./models.ts"

/** Payload of POST /api/llm/probe-apply (spec §2.2): the client confirms and
 * the host probes THEN adopts ALL discovered rows (upsert by id — overwrite +
 * add, never delete) into `llm.providers.<route>.models`. The draft key is used
 * in memory only (probe chain) and is never persisted or echoed. */
export interface ProbeApplyResult {
  /** Number of discovered model rows adopted (the probe's full list — an
   * idempotent re-apply of identical rows still reports them as adopted). */
  adopted: number
  /** The discovered rows — the probe's own normalized ModelDescriptors. */
  models: ModelDescriptor[]
  /** sha256(route + baseURL + apiKey): the fetch-key identity marker. A changed
   * key/baseURL yields a different fingerprint, so a client can discard stale
   * results (v0: no server-side seq — the client owns invalidation). */
  fingerprint: string
  /** Per-model adoption failures. ALWAYS ABSENT in v0: probeModels either
   * returns fully-normalized rows or throws before any write (never half-write). */
  failures?: unknown[]
}

export type Endpoint =
  | "session"
  | "chunk"
  | "reasoning"
  | "agent-state"
  | "approval"
  | "question"
  | "command"

export type ClientMessage =
  | { type: "open"; streamId: string; endpoint: Endpoint; payload: unknown }
  | { type: "cancel"; streamId: string }
  // Client approval decision (controller ruling 1): the SPA sends this over
  // the mux with `streamId` = the approval stream it is answering on; the mux
  // `receive` routes `value` to the host's ApprovalMuxBridge →
  // ApprovalWaterfall.respond (keyed by the globally-unique approvalId).
  | { type: "approval"; streamId: string; value: ApprovalResponseWire }
  // Client question answer (task 3.3): the same mux pattern as `approval` —
  // `streamId` names the question stream being answered; the mux `receive`
  // routes `value` to the host's QuestionMuxBridge → QuestionWaterfall.respond
  // (keyed by the globally-unique questionId).
  | { type: "answer"; streamId: string; value: QuestionResponseWire }

export type ServerMessage =
  | { type: "ready"; streamId: string }
  | { type: "item"; streamId: string; value: unknown }
  | { type: "end"; streamId: string }
  | { type: "error"; streamId: string; error: unknown }

export interface SessionPage {
  events: SessionEvent[]
  hasMore: boolean
  nextBeforeSeq?: number
  // C2 (afterSeq forward replay): the last event's seq of the returned page —
  // the client's resume-after-disconnect cursor. Present only when the call
  // used afterSeq.
  nextAfterSeq?: number
}

export interface ApprovalRequestWire {
  approvalId: string
  name: string
  reason: string
  command?: string
  argv?: string[]
  dangerClass?: "extreme" | "dangerous" | "none"
  pathSummary?: string
}

export interface ApprovalResponseWire {
  approvalId: string
  approved: boolean
}

/**
 * Item yielded on the mux `question` stream (task 3.3): ONE question at a
 * time, keyed by a wire-level `questionId` — the existing `UserQuestion.id`
 * (a caller-supplied correlation id) is carried as the optional `kind` marker
 * so the UI can label which code path raised the question. `options` are the
 * seam's quick-pick choices (free-form answer otherwise).
 */
export interface QuestionRequestWire {
  questionId: string
  text: string
  kind?: string
  options?: string[]
}

/** Payload of the mux `{type:"answer"}` client frame (task 3.3). */
export interface QuestionResponseWire {
  questionId: string
  answer: string
}

/** Payload of a mux `command` open (controller ruling 3). */
export interface CommandRequestWire {
  sessionId: string
  prompt: string
}

/** Frames yielded on the mux `command` stream (controller ruling 3). */
export type CommandEventWire =
  | { status: "started" }
  | { status: "ok" }
  | { status: "error"; error: string }

// ── Task 4.1 commands RPC seam ─────────────────────────────────────────────
// Commands are the OTHER dispatch seam from the mux `command` turn stream:
// UI-plane slash commands (DSH commands.{list,execute} parity) whose results
// are returned to the caller directly and NEVER enter the model history
// (audit F05-6). The host exposes them over HTTP — the palette needs the
// list upfront (a one-shot GET) and execution is a single request/response.

/** Payload of POST /api/commands/execute. */
export interface CommandExecuteRequestWire {
  sessionId: string
  /** Full command line, e.g. "theme dark" or "/theme dark". */
  line: string
}

/**
 * Embedder-owned command bridge behind GET /api/commands +
 * POST /api/commands/execute. The embedder composes it over
 * @i-harness/interaction's registerCommand/runCommand — the host owns the
 * HTTP transport and the wire shapes only.
 */
export interface CommandBridge {
  /** Currently registered command descriptors (name-sorted, never the handlers). */
  list(): CommandDescriptor[]
  /**
   * Execute one command line for a session. Resolves with the command's
   * result text; rejects with the failure message (unknown command, handler
   * error, aborted). The signal aborts on client disconnect.
   */
  run(sessionId: string, line: string, signal: AbortSignal): Promise<string>
}

// ── Task 5.4b: file-references RPC seam (DSH fileReferences.list parity) ────
export interface FileReferencesBridge {
  list(workspaceId: string, query: string): Promise<FileReferenceCandidate[]>
}

// ── Task 5.5: jobs kill RPC seam (jobs popover kill button) ─────────────────
export interface JobKillBridge {
  kill(sessionId: string, jobId: string): Promise<JobKillOutcome>
}

// ── Task 6: plugins seam (SPA marketplace) ──────────────────────────────────
export interface PluginsCatalogView {
  sources: PluginSourceInfo[]
  plugins: CatalogPlugin[]
}

export interface PluginRuntimeView {
  id: string
  enabled: boolean
  overall: OverallStatus
  capabilities: Record<"skills" | "commands" | "mcp" | "executable", CapabilityStatus>
  commandStatuses: Record<string, CommandStatus>
}

export interface PluginsRuntimeView {
  plugins: PluginRuntimeView[]
}

/**
 * Minimal structural face of the plugin RUNTIME the host's routes need — an
 * ADAPTER CONTRACT, not a literal method subset: the raw PluginRegistry does
 * not satisfy it (its catalog() returns { plugins } without the sources, and
 * it has no runtime()). The embedder supplies a COMPOSED WRAPPER (apps/cli
 * glue) that satisfies it. Mutations resolve/reject with the registry's typed
 * errors — the host maps each to its HTTP status (forwardPluginRegistryError).
 */
export interface PluginRegistryFace {
  catalog(): Promise<PluginsCatalogView>
  runtime(): PluginRuntimeView[]
  addSource(source: string): Promise<void>
  refreshSource(name: string): Promise<void>
  removeSource(name: string): Promise<void>
  install(id: string): Promise<void>
  uninstall(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
}

// ── Task 4 (models plan): model-sources seam ─────────────────────────────────
/**
 * Minimal face of the credential store (one-way describe + set/unset). The
 * real @i-harness/credentials store satisfies it structurally; describe never
 * returns a value. `resolve` is the OPTIONAL internal read chain (env > file,
 * non-echoing): the host calls it on POST /api/llm/probe.
 */
export interface CredentialStoreFace {
  describe(refs: string[]): Record<string, CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  resolve?(ref: string): string | undefined
}

/**
 * Minimal face of the provider registry: the two view/probe methods the
 * models routes need. The real @i-harness/provider ProviderRegistry satisfies
 * it structurally (describeDirectory / probeModels). `protocol` is the
 * CONTROLLER-RESOLVED wire protocol — the host resolves and passes it.
 */
export interface ProviderRegistryFace {
  describeDirectory(): DirectoryEntry[]
  probeModels(route: string, req: { baseURL?: string; apiKey?: string; protocol?: string }): Promise<ModelDescriptor[]>
}

/**
 * The model-settings seam (WebHostOptions.modelSources). Every FIELD is
 * optional; a route answers 404 when its backing piece is absent.
 */
export interface ModelSources {
  settingsStore?: SettingsStore
  credentialStore?: CredentialStoreFace
  providerRegistry?: ProviderRegistryFace
}
