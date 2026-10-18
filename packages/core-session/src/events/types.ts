import type { InputDisplay, InputSynthetic, UserMessageInput } from "../inbox.ts"
import type { ImageInput, ImageSummary } from "../images.ts"
import type { ProviderThinkingBlock, ProviderContinuation } from "../projection/types.ts"
import type { PruneRecord } from "../projection/pruning.ts"
import type { InputProvenance } from "./conversation.ts"

export interface ModelRetryInfo {
  requestId: string
  phase: "waiting" | "attempting" | "recovered"
  attempt: number
  maxRetries?: number
  delayMs: number
  nextAttemptAt?: number
  code: string
  httpStatus?: number
  providerId?: string
  modelId?: string
  discardOutput?: true
}

/** Ephemeral per-physical-attempt state. No model text or transport data. */
export interface ModelActivityInfo {
  requestId: string
  phase: "connecting" | "streaming" | "quiet" | "settled"
  startedAt: number
  lastProgressAt?: number
  waitingFor: "first-response" | "progress"
  outcome?: "completed" | "failed" | "cancelled"
}

// `&` binds tighter than `|`, so the intersection must wrap the whole union —
// otherwise only the last member would carry `ignorable`.
export type SessionEvent =
  | (
    | { type: "turn/start"; seq?: number }
    | { type: "step/start"; actionId?: string; attemptId?: string; seq?: number }
    | { type: "step/failed"; seq?: number }
    | { type: "model/retry"; version: 1; ts: number; retry: ModelRetryInfo; seq?: number }
    | { type: "model/activity"; version: 1; ts: number; activity: ModelActivityInfo; seq?: number }
    // `internal: true` = model-visible but NOT a user-facing turn (runtime-
    // context snapshots, guard nudges): the projection keeps it, the TUI
    // scrollback skips it. Additive — old logs simply never carry it.
    | { type: "user/message"; seedInputContext?: { rawMessageSeq: number }; inputPreparation?: import('./input-preparation.ts').InputPreparationLink; provenance?: InputProvenance; text: string; seq?: number; input?: UserMessageInput; source?: { kind: "plugin"; plugin: string }; internal?: true; images?: ImageInput[]; imageInputId?: string; imageSummaries?: ImageSummary[] }
    | { type: "assistant/chunk"; text: string; seq?: number }
    | { type: "assistant/message"; text: string; seq?: number; thinkingBlocks?: ProviderThinkingBlock[]; providerContinuation?: ProviderContinuation }
    | { type: "tool/call"; callId: string; name: string; args: unknown; seq?: number }
    // M4: the DISPATCH BOUNDARY. `tool/call` is written when the MODEL emits the
    // call; the body runs later, in a batch (core-agent/src/index.ts:261-264).
    // Without this marker a `tool/call` with no `tool/result` is indistinguishable
    // between "never dispatched" and "dispatched, outcome unknown" — and the two
    // demand opposite responses. Written BEFORE the body starts.
    // `callId` is the identity; `eventSeq` is the durable seq of the `tool/call`
    // it belongs to, present when the caller knows it (the production path does).
    | { type: "tool/dispatch"; callId: string; eventSeq?: number; seq?: number }
    | { type: "tool/result"; callId: string; name: string; output: unknown; isError?: true; seq?: number }
    // Durable Code Mode inspection records; only outer exec/wait results enter inference.
    | { type: "code/cell"; cellId: string; sessionId?: string; parentCallId?: string; state: "started" | "running" | "completed" | "failed" | "terminated" | "interrupted"; source?: string; error?: string; seq?: number }
    | { type: "code/call"; cellId: string; parentCallId?: string; callId: string; name: string; args: unknown; seq?: number }
    | { type: "code/dispatch"; cellId: string; callId: string; eventSeq?: number; seq?: number }
    | { type: "code/result"; cellId: string; callId: string; name: string; output: unknown; isError?: true; seq?: number }
    | { type: "code/output"; cellId: string; content: unknown; seq?: number }
    | { type: "context/result-ref"; ignorable?: true; ref: { id: string; workspaceId: string; sessionId: string; callId: string; label: string; revision: string; bytes: number; originalBytes: number; complete: boolean; expiresAt: number; source?: { sourceId: string; path?: string; revision?: string; readonly?: boolean } }; seq?: number }
    // Candidate JSON writes become replayable only with a later successful
    // terminal code/cell record for this owner; later failure/stop suppresses them.
    | { type: "code/store"; version: 1; cellId: string; sessionId?: string; writes: Array<[string, unknown]>; seq?: number }
    | { type: "step/end"; seq?: number; /** M72 Ⅱ: the provider stopped at the output cap. */ truncated?: true; /** M77: the provider REFUSED to produce content (HTTP 200, no content, a bare `end` at the seam). Written only as `true` — absent stays absent, exactly like `truncated`, and the two are INDEPENDENT: one step can be both. */ refused?: true; /** M80: the provider returned NO content at all — an empty success (HTTP 200, no text, no tool call, a bare `end`). Written only as `true`; absent stays absent. Excluded by construction from a step that was `truncated` or `refused` (those are the more specific facts about the same step), and a step whose only output was a tool call is NOT empty. */ empty?: true }
    | { type: "turn/end"; seq?: number }
    | { type: "subagent/inbox"; messageId: string; message: string; provenance?: InputProvenance; seq?: number }
    | { type: "compaction/start"; seq?: number }
    | { type: "compaction/end"; seq?: number }
    | { type: "compaction/summary"; text: string; shadowedSeqs: number[]; seq?: number }
    // M20: pure-reset marker (compaction.resetWindow — absorb codex token-budget:
    // 新 context window、保留最近 N 條、無摘要)。Additive event type, format v1
    // stays. FIX ROUND 1 (Ruling 4): append-only durability — the marker does
    // NOT accompany a truncation; it RECORDS the removed seqs so deriveMessages
    // can shadow them (same mechanism as compaction/summary.shadowedSeqs).
    // Persistence backends are append-only, and recovery replays the log ⇒
    // nothing lost: every raw event stays durably recorded. Carries no
    // user-facing text → deliberately unindexed (default "").
    | { type: "compaction/reset"; removedSeqs: number[]; seq?: number }
    // M33: model-free prune pass — a single tool/result whose stringified
    // output was truncated ON THE PROJECTION SURFACE (append-only iron rule:
    // the raw log keeps the FULL output — dsh 的「剪完整舊結果」語義 hits the
    // derived surface only). deriveMessages substitutes
    // `head + "\n…(pruned N bytes)…\n" + tail` for matching callIds; the
    // compaction engine's renderShadowed applies the same substitute to the
    // summarizer input. Carries no model-visible text itself (default branch).
    | { type: "compaction/prune"; version: 1; pruned: PruneRecord[]; seq?: number }
    // M16: log-only sandbox session-mode marker (approval/* precedent) — mode is
    // a local union so core-session stays dependency-free (sandbox-policy owns
    // the real SandboxMode type; a sandbox import here would create a cycle).
    | { type: "sandbox/mode"; mode: "read-only" | "workspace-write" | "danger-full-access"; source?: "delegation"; seq?: number }
    // M19 subagent teams: team/* log events (version 1). The snapshot shapes
    // are INLINED (not imported from agent-team) — core-session must stay
    // dependency-free; agent-team imports core-session, so a reverse import
    // would create a cycle. Keep structurally identical to TeamEvent in
    // agent-team/src/types.ts.
    | { type: "team/member"; version: 1; teamId: string; member: { id: string; name: string; description: string; provider: string; context: "fresh" | "fork"; phase: "provisioning" | "active" | "failed"; error?: string; sessionId?: string }; seq?: number }
    | { type: "team/task"; version: 1; teamId: string; task: { id: string; revision: number; subject: string; description: string; status: "pending" | "in_progress" | "completed" | "deleted"; ownerId?: string; blockedBy: string[]; writeScopes: string[] }; seq?: number }
    | { type: "team/message/queued"; version: 1; teamId: string; message: { id: string; senderId: string; senderName: string; targetId: string; delivery: "quiet" | "wakeup"; content: string; display?: InputDisplay }; seq?: number }
    | { type: "team/message/delivered"; version: 1; teamId: string; messageId: string; targetId: string; seq?: number }
    // M21 todo tool: whole-list snapshot writes (version 1). INLINED like
    // team/* above so core-session stays dependency-free (the todo tool owns
    // the richer shape and reuses these names). No model-visible text →
    // deliberately unindexed (deriveMessages/deriveSearchText defaults).
    | { type: "todo/write"; version: 1; items: TodoItem[]; seq?: number }
    // Task 4.2 goals (DSH goal/change parity, simplified): whole-snapshot
    // `goal/change` events — every non-clear operation carries the COMPLETE
    // post-change goal state (last-wins fold, DSH's exact rule) so the
    // projection is a pure replay; a clear carries no `goal` but a tombstone
    // `cleared` ref (projection → null). UI-plane: deriveMessages skips it
    // (default branch — the model surface is unchanged) and deriveSearchText
    // returns "" (unindexed). Additive event type; format version stays 1.
    | { type: "goal/change"; version: 1; operation: GoalOperation; goal?: GoalSnapshot; cleared?: GoalRef; updatedAt?: number; seq?: number }
    // Task 4.4 jobs 状态流基础版: per-job lifecycle snapshot events emitted by
    // the subagent layer's job registries on every observable transition
    // (register → running; update → completed/error/re-opened running; kill →
    // killed). Whole-job snapshot per event so a consumer folds last-wins by
    // jobId (the goal/change pattern — the log alone rebuilds the list).
    // UI-plane: deriveMessages' default branch keeps it model-invisible and
    // deriveSearchText returns "" (unindexed). Additive event type; format
    // version stays 1. The status vocabulary is @i-harness/subagent's
    // JobStatus — INLINED because core-session must stay dependency-free
    // (team/* precedent); the producer (subagent persist.ts) owns the event.
    | { type: "job/status"; version: 1; job: { jobId: string; kind: string; label: string; status: "running" | "completed" | "killed" | "error"; outputAvailable: boolean; startedAt?: number; endedAt?: number }; seq?: number }
    // E9 schedule: durable schedule mutation events (dsh schedule/change
    // parity, IH-shaped: payload fields inline — the shape's single source is
    // packages/schedule). UI-plane: deriveMessages default branch keeps it
    // model-invisible; deriveSearchText returns "" (unindexed). Additive.
    | { type: "schedule/change"; version: 1; operation: "create" | "delete" | "dispatch"; schedule?: { id: string; kind: "after" | "at" | "every"; prompt: string; afterSeconds?: number; everySeconds?: number; scheduledAt: string }; id?: string; acceptedAt?: string; seq?: number }
    // R-A1 input tiers: durable inbox ladder (dsh agent/inbox/spliced +
    // opencode admit→promote→cancel re-implemented in i-harness vocabulary).
    // `admitted` is the durable enqueue; `promoted` marks consumption (the
    // consuming user/message follows in the same log — an active turn's
    // user/message is appended by the agent loop, an idle turn's by the
    // executor's agent.run); `cancelled` retracts a never-promoted input.
    // All three are log-only (never model-visible; the text enters the model
    // surface only through the promoted user/message). version 1 (M19/M21
    // convention for structured new event slots).
    | { type: "agent/input/admitted"; preparationPolicy?: 'human-host'; supplementalContext?: string; provenance?: InputProvenance; version: 1; inputId: string; text: string; delivery: "queue" | "steer"; intent: "user" | "system"; synthetic?: InputSynthetic; images?: ImageInput[]; clientToken?: string; seq?: number }
    | { type: "agent/input/promoted"; version: 1; inputId: string; seq?: number }
    | { type: "agent/input/cancelled"; version: 1; inputId: string; reason?: string; seq?: number }
    // R-A6 session title: latest-wins log-only snapshot (dsh `session/title`).
    // Never model-visible; deriveSearchText defaults ("").
    | { type: "session/title"; title: string; messageSeqs: number[]; source: "fallback" | "provider" | "user"; seq?: number }
    // R-A7 plan mode: log-only mode marker + the proposal text (the proposal is
    // ALSO appended as a regular user/message when entering; this event carries
    // the mode + attribution, never model-visible itself).
    | { type: "plan/mode"; mode: "on" | "off"; proposal?: string; seq?: number }
    // M26 (R-D1): subagent task protocol log events (version 1). INLINED like
    // team/* so core-session stays dependency-free. Log-only (deriveMessages
    // skips them — the parent wake input arrives via the A-plan input tier);
    // subagent/start is appended on task submit, subagent/end on terminalize.
    | { type: "subagent/start"; version: 1; taskId: string; agentPath: string; role: string; description: string; parentSessionId?: string; seq?: number }
    | { type: "subagent/end"; version: 1; taskId: string; outcome: "completed" | "error" | "cancelled" | "recovery-required"; resultText?: string; error?: string; seq?: number }
    // C-region port (R-C1): the model's thinking trajectory, persisted to the
    // log but deliberately model-INVISIBLE — deriveMessages skips it (default
    // branch) and deriveSearchText returns "" (unindexed). Additive event type;
    // format version stays 1. The PRODUCER is A/B-region (llm layer); the live
    // `reasoning` mux stream carries it.
    | { type: "reasoning"; text: string; blockId?: string; streamId?: string; seq?: number }
    // Display-only deltas. `streamId` identifies one canonical reasoning
    // record; offsets count UTF-16 characters, and atSeq positions this live
    // block before the next durable record. Published, never appended.
    | { type: "reasoning/chunk"; text: string; streamId: string; blockId?: string; offset: number; atSeq: number; seq?: number }
    // C-region port (R-C1 commands lifecycle, DSH commands parity): a slash
    // command's execution pair, appended by the executing host before/after the
    // handler. UI-plane (audit F05-6): the command never creates a model
    // message (default branches) and is unindexed.
    | { type: "command/run"; commandId: string; name: string; args?: string; source: { kind: "user" }; seq?: number }
    | { type: "command/done"; commandId: string; kind: "success" | "error"; text?: string; seq?: number }
    // M42 conversation rewind (G2): the rewind engine's durable point —
    // APPENDED by the rewind service (packages/rewind) at the moment a rewind
    // is applied; core-session owns the union entry + the projection
    // semantics only. Spec §3: after a rewind, events in [anchorSeq, marker)
    // are HIDDEN on the model surface; events appended AFTER the marker (new
    // turns) are visible again. deriveMessages applies `rewindCuts` as a
    // SECOND skip mechanism alongside compaction shadowedSeqs (same
    // append-only iron rule: the raw log is never rewritten — recovery
    // replays the full history plus the marker). Log-only and unindexed:
    // deriveMessages' default branch keeps it model-invisible and
    // deriveSearchText returns "" (team/* precedent). version 1 (M19/M21
    // convention for structured new event slots).
    | { type: "rewind/point"; version: 1; targetTurn: number; anchorSeq: number; mode: "all" | "files" | "conversation"; fileOps: Array<{ path: string; op: "restore" | "delete" }>; seq?: number }
    // M3 §3.4: the durable run-end record. The CLI's run path appends it at
    // each producing exit (pre-assembly failure / success / run failure) so a
    // failed run is diagnosable AFTER the fact — `failureReport` lives only on
    // stderr, and the completion definition ("一次失敗的執行不需要人手讀 JSONL
    // 就能定位") needs a record that outlives the process. The phase vocabulary
    // is @i-harness/diagnostics' DiagnosticPhase — INLINED because core-session
    // must stay dependency-free (job/status precedent, :81-83); the producer
    // (the CLI run path) owns the event, and its assignment is the compile-time
    // check that the two sets stay equal. UI-plane: deriveMessages' default
    // branch keeps it model-invisible and deriveSearchText would return ""
    // (unindexed). Additive; format version stays 1.
    | { type: "operator/run-end"; version: 1; runId: string; exitCode: number; durationMs: number; phase: "cli" | "config" | "run" | "turn" | "sdk" | "session" | "mount" | "shutdown"; error?: string; seq?: number }
    | import("./context.ts").ContextEvent
    | import("./generation.ts").GenerationEvent
    | import('./input-preparation.ts').InputPreparationEvent
    | import("./conversation.ts").ConversationSemanticsEvent
    | import("./conversation.ts").ExchangeAcceptedEvent
    | import("./replacement.ts").ContextReplacementRecordV1
  )
  & { ignorable?: true }

// M21 todo tool item shape (snapshot carried by every todo/write event). Each
// write REPLACES the visible list wholesale; status lives on the item, not the
// session, so the harness never derives todo progress from the log itself.
export type TodoItemStatus = "pending" | "in_progress" | "completed"
export interface TodoItem {
  content: string
  status: TodoItemStatus
}

// ── Task 4.2 goal vocabulary (goal/change payload shapes) ────────────────────
// DSH-aligned names (dsh-goal: GoalPhase/GoalOperation/GoalRef/GoalSnapshot),
// simplified for our v0: no `blocked` phase / blockedReason (block is a DSH
// policy verb we do not implement), no mandatory maxGoalRounds (DSH configures
// a deployment default of 256; we have none — an omitted cap simply carries
// no cap), and no round admission (roundsStarted — out of scope; the
// projection's `round` stays a documented seam).
export type GoalPhase = "active" | "paused" | "complete"
export type GoalOperation = "create" | "edit" | "pause" | "resume" | "complete" | "clear"

/** Compare-and-set identity for one exact goal revision (DSH GoalRef shape). */
export interface GoalRef {
  id: string
  revision: number
}

/** Goal state written by every non-clear goal mutation (DSH GoalSnapshot shape). */
export interface GoalSnapshot extends GoalRef {
  objective: string
  phase: GoalPhase
  maxGoalRounds?: number
}

// Lineage/identity carried on a session (M8): who spawned it and how deep in
// the subagent delegation chain it sits. Optional — a root session has none.
export interface SessionHeader {
  journal?: import('../managed/types.ts').JournalMetadata
  parentSession?: string
  seedLength?: number
  delegationDepth?: number
  origin?: string
}

export interface Session {
  formatVersion: number
  events: SessionEvent[]
  header?: SessionHeader
}

export const CURRENT_FORMAT_VERSION = 9
