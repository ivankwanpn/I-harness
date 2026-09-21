// packages/session-executor/src/assembly.ts — R-C0 (engine-owned posture).
// ONE assembly implementation. `runHeadless` (one-shot) and the web
// `createSessionService` (multi-turn) both build through this. The branch's
// per-session live-agent file no longer exists (its full environment was the
// old run.ts; the CURRENT run.ts environment — terminal/web/ask_user_input/
// output-spill/plan-mode/guardian/instructions/runtime-context/mcp-oauth —
// is the source of truth and sinks here verbatim).
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { append, createSession, Inbox, subscribe, type Session } from "@i-harness/core-session"
import { RewindError, RewindRecorder, RewindStore } from "@i-harness/rewind"
import { createToolRegistry, registerContextRemaining } from "@i-harness/core-tools"
import { createAgent, type Agent, type ReasoningEffort } from "@i-harness/core-agent"
import { approxTokens, type CompactionConfig, type CompactionRequest, type CompactionResult } from "@i-harness/compaction"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { registerShell, type ShellRetentionOptions } from "@i-harness/shell"
import { registerTerminal, type TerminalMountHandle } from "@i-harness/terminal"
import { registerWeb } from "@i-harness/web"
import { createFsTools } from "@i-harness/fs"
import { createTodoTool } from "@i-harness/todo"
import { createReadImageTool } from "@i-harness/attachment"
import { createApprovalPolicy, registerGuardian } from "@i-harness/guard-approval"
import { createRetryGuard, type RetryConfig } from "@i-harness/guard-retry"
import { createOutputSpillGuard, type OutputSpillGuardConfig } from "@i-harness/output-retention"
import { createTimeoutGuard } from "@i-harness/guard-timeout"
import { createRepeatToolGuard } from "@i-harness/guard-repeat-tool"
import type { ExecService } from "@i-harness/exec"
import { registerApprovalAnswerer, registerAskUserInput } from "@i-harness/interaction"
import { installRuntimeContext } from "@i-harness/runtime-context"
import { createInstructionsSection } from "@i-harness/instructions"
import { PLAN_MODE_SYSTEM_PROMPT, ensurePlanModeTool } from "@i-harness/plan-mode"
import { registerToolSearch } from "@i-harness/tool-search"
import { createFsSearchTools } from "@i-harness/fs-search"
import { createScheduleDriver } from "@i-harness/schedule/driver"
import { createScheduleTools } from "@i-harness/schedule/tools"
// BUG-1 (m49 audit): node:sqlite's ExperimentalWarning is suppressed by the
// session-query package itself (a module side effect that evaluates before
// its node:sqlite import) — the assembly needs no explicit wiring.
import { createSessionQueryTools, type SessionQuery } from "@i-harness/session-query"
import { registerSubagent, createStaleSubagentsSection, projectWorkflowRows, type AgentTaskView, type ParentInputAdmission, type SubagentRole, type SubagentStateSnapshot } from "@i-harness/subagent"
import { registerSkills } from "@i-harness/skills"
import { registerWorkflow, type WorkflowMountHandle } from "@i-harness/workflow"
import {
  mountMcpClient,
  type McpMountHandle,
  type McpOAuthConfig,
  type McpServerConfig,
  type McpServerState,
  type McpServerStatusEvent,
  type McpTokenStore,
} from "@i-harness/mcp-client"
import type { Telemetry } from "@i-harness/telemetry"
// Type-only: the role selection's protocol is the SAME closed set settings
// validates (`SettingsProviderProtocol`) — a copy of the five names here would
// be another place to edit one enum. Erased at build time, no runtime edge.
import type { SettingsProviderProtocol } from "@i-harness/settings"
import { mountLspClient, type LspMountHandle, type LspServerConfig } from "@i-harness/lsp"
import {
  mountAgentTeams,
  type TeamDeps,
  type TeamMountHandle,
  type TeamConfig,
} from "@i-harness/agent-team"
import { createLocalSandbox } from "@i-harness/sandbox-local"
import { checkWrite, createSandboxPolicy, renderPolicyContext } from "@i-harness/sandbox-policy"
import type { SandboxMode, SandboxProvider } from "@i-harness/sandbox"
import { createApprovalEscalationApprover, denialFor, type ApprovalPrompt } from "@i-harness/sandbox"
import { DEFAULT_AGENT_PRESET, parsePreset } from "@i-harness/preset"

export type ModelPolicy = "required" | "test-mock"

export class ModelUnavailableError extends Error {
  constructor(message = "No model configured") {
    super(message)
    this.name = "ModelUnavailableError"
  }
}

/** What a `resolveRoleModel` resolver answers. Structural on purpose: the
 * provider runtime's own answer satisfies it exactly as it stands — this
 * package stays independent of provider-runtime (the same reason service.ts
 * declares its own binding result type), and the subagent seam this feeds
 * reads nothing but the status, the reason and the client. The ready arm also
 * admits `reasoningEffort`: the runtime resolves the selection's effort (and
 * refuses an invalid one), and the spawn hands it to `createAgent` instead of
 * dropping it at the boundary — the field is the runtime binding's own. */
type RoleModelResolution =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; binding: { client: ModelClient; reasoningEffort?: ReasoningEffort } }

/** The selection a ROLE carries — what settings' `agents.roles.<name>` entry
 * holds, and what subagent's own `RoleModelSelection` is: named here so the
 * resolver's input and the host's declared roles cannot describe two different
 * shapes. Nothing in this package names either concrete type. */
type RoleModelSelection = {
  provider: string
  model: string
  protocol?: SettingsProviderProtocol
  reasoningEffort?: string
}

// The m26 mock client is destructive (one script step per turn, exhausted →
// error). For the web path (repeated turns on ONE assembly with the default
// mock) wrap it so every stream() call serves a fresh copy of the cycle.
function cyclicMockClient(script: MockStep[]): ModelClient {
  return {
    async *stream(request: import("@i-harness/llm-seam").LLMRequest) {
      yield* createMockClient(script.slice()).stream(request)
    },
  }
}

export interface AssemblyOptions {
  /** Session id — telemetry attribution + subagent persist stateId. A one-shot
   * run may have none. */
  sessionId?: string
  workspace: string
  /** Explicit clients always win. Under `required`, absence rejects instead
   * of constructing a mock. Omitted policy is production-safe `required`;
   * tests must opt into `test-mock` explicitly. */
  modelPolicy?: ModelPolicy
  model?: ModelClient
  modelLabel?: string
  mockScript?: MockStep[]
  /** Only the MOCK default honors this: repeat:true cycles the single "ok"
   * step so repeated turns on one assembly (web) survive — CLI one-shot keeps
   * the one-shot mock semantics. */
  mockCycles?: boolean
  approveAll?: boolean // true → auto-approve; false/unset → NO answerer (host wires the bridge; fail-closed)
  sandbox?: SandboxMode
  shellTimeoutMs?: number // default 120_000
  /** W10: a FOREGROUND bash/pwsh command still running after this many ms is
   * handed back as a job id — and keeps running — instead of dying at
   * `shellTimeoutMs` with its work lost. Default 30_000.
   *
   * MUST stay WELL UNDER `shellTimeoutMs` (default 120_000): the deadline kills
   * the command outright, so a threshold at or above it never fires and this
   * whole feature is dead config. See the note at the two defaults in the
   * body. */
  shellBackgroundAfterMs?: number
  shellRetention?: ShellRetentionOptions // M12: cap bash/pwsh output
  retry?: RetryConfig // M12: opt-in tool retry-on-timeout
  maxParallelToolCalls?: number // M13: bound on concurrent tool bodies per step
  mcp?: McpServerConfig[] // M17: MCP servers to mount
  pluginMcp?: McpServerConfig[] // per-server containment; pluginMcpResults reports
  // Plugin-contributed subagent roles, registered into the SAME RoleRegistry the
  // builtin roles seed into. Placement is load-bearing twice, and NOT for the
  // reason it first looks like: guardian/team hold the same registry object, so
  // they read a late registration fine. What matters is registerSubagent itself
  // — it restores the snapshot's roles first, then swaps in the persistence
  // wrapper. Registering after it means a plugin role is PERSISTED (a role
  // registered before the wrapper is installed never would be) and can never
  // clobber a restored, user-edited role. A name already taken is SKIPPED, never
  // replaced; pluginAgentResults reports per role like pluginMcpResults does.
  pluginAgents?: SubagentRole[]
  lsp?: LspServerConfig[] // M18: LSP servers to mount
  skills?: { extraDirs?: string[] } // plugin overlay skill roots
  team?: Partial<TeamConfig> // M19: mount the agent-team domain
  sessionQuery?: SessionQuery // M10b: session_search + lineage tools
  // M11: the window is NOT part of the host contract — the assembly resolves it
  // (see `CompactionRequest`) and fills it in before handing the engine a config.
  compact?: CompactionRequest
  /** M42 G1: rewind engine — store root. When set (together with sessionId,
   * which keys the storage dir `rewind/<sessionId>/`) the assembly creates the
   * RewindStore + RewindRecorder, subscribes user/message → begin / turn/end →
   * finalize, and injects the pre-image sink into the fs write tools. Absent →
   * rewind is entirely off (pre-M42 behavior, zero cost). M54: the store is
   * bound to `workspace` (meta.json) and a turn that crashed mid-flight is
   * recovered as an honest orphan at creation; a journal bound to ANOTHER
   * workspace leaves rewind off entirely (warned, assembly.rewind absent). */
  rewindStoreRoot?: string
  preset?: string // JSON AgentPreset text (@i-harness/preset): overrides the base system prompt
  planMode?: boolean // R-A7: plan-mode prompt fragment + exit_plan_mode tool
  guardian?: { policy?: string; timeoutMs?: number; model?: ModelClient } // R-A9
  outputSpill?: OutputSpillGuardConfig // M26-B7: registry-level output spill
  session?: Session // M14: host-pre-seeded session (host owns durability)
  /** The session the sandbox policy resolution READS for `sandbox/mode` events.
   * Defaults to the LIVE session (`opts.policySession ?? session`): a host that
   * passes only `session` (the web service) would otherwise resolve against
   * nothing forever and never observe a mid-session change. `run.ts` passes the
   * same object for both, so it is unaffected either way.
   *
   * ONLY events appended after the assembly is constructed count. Restored
   * history records decisions made by EARLIER runs; letting it win would enforce
   * them over the mode THIS run requested — `--resume X --sandbox read-only` on a
   * session once escalated would run unrestricted. */
  policySession?: Session
  coordinator?: SessionCoordinator // when present (+sessionId): write-behind + subagent persist
  restoredState?: SubagentStateSnapshot // resume: subagent registries rebuilt from the doc
  telemetry?: Telemetry // shared stream; NEVER closed here — the owner owns it.
  /** When persist is active, append `job/status` events to the LIVE session too
   * (the web jobs surface reads them; CLI parity keeps them off — default). */
  jobStatusEvents?: boolean
  /** M27-R-A8: model context window (tokens) — M15 provider-record knowledge
   * supplied by the composition (e.g. web.ts via resolveModelContext). Absent →
   * get_context_remaining is NOT registered (fail-closed). */
  contextWindow?: number
  /** M26-D2: durable task completion → parent session input admission. Wire to
   * the host's input tier (run.ts builds the default over its executor lane);
   * absent → notification rows stay pending (fail-closed, no silent drop). */
  parentNotify?: ParentInputAdmission
  /** M32 T3: per-assembly reasoning effort — forwarded verbatim to the agent,
   * which copies it onto every LLMRequest (the adapter owns the wire
   * translation). Absent → requests never carry the field (provider default).
   * The web path resolves it per session from meta.modelSelection
   * (see SessionServiceOptions.reasoningEffortFor). */
  reasoningEffort?: ReasoningEffort
  /** Resolve a ROLE's model selection. The host supplies it from the same
   * runtime `modelBindingFor` uses, so a sub-agent's provider, credential and
   * capability card come from the one provider plane this harness has.
   *
   * Optional because an embedder may serve no role that names a model. Absent,
   * the spawn of such a role FAILS naming the selection rather than inheriting
   * the session's model in silence — a role that names one model and runs
   * another is the wrong answer stated as a right one. */
  resolveRoleModel?: (selection: RoleModelSelection) => Promise<RoleModelResolution>
  /** The HOST's declared role models — settings' `agents.roles.<name>`. A
   * CALLBACK on purpose, read at SPAWN time: a settings edit applies to the
   * next spawn without restarting the session (spec §3). Absent → no role has a
   * declared model and every spawn inherits the session's client. */
  roleSelectionFor?: (roleName: string) => RoleModelSelection | undefined
  /** `plugins.subagentModel`: whether a role may run on its own declared model
   * at all. ABSENT MEANS OFF — the setting's own default is false, and a host
   * that never wired it has not enabled the feature. Off, a spawn of a role
   * with a declared model FAILS naming both fixes rather than running it on the
   * session's model in silence. */
  allowSubagentModelSelection?: boolean
  /** W11: how long a sub-agent may RUN before the `subagents` runtime-context
   * section names it to the main agent. Default 600_000 (10 min). It is a
   * threshold on the CURRENT run, not on the entry's age, and it starts no
   * turn: the section renders at the next `agent/pre-step` the session is
   * already taking (idle self-wake is a settled product NO — 2026-09-20).
   *
   * THE TWO NUMBERS THIS ONE IS READ AGAINST, both measured on this tree:
   * `wait_agent`'s clamp and `spawn_agent background:false` both cap the
   * PARENT's blocking wait at 300_000 (both in `packages/subagent/src/tools.ts`
   * — cited by SYMBOL, deliberately: they sit a dozen lines apart in a file
   * this unit edits, and the first draft of THIS comment named two line numbers
   * that its own import moved), so a parent that chose to
   * block already spends up to five minutes learning "still running" — a
   * threshold at or below that reports children whose answer the waiter just
   * received. On the other side, the problem W11 exists for is a child
   * "already running 20 minutes" nobody has been told about —
   * `docs/handoff/2026-09-20-queued-work.md` §8.5 (W11), cited by section
   * because that document is edited by every unit and the line moves with it:
   * a threshold at or above the example arrives after the run stopped being
   * interesting. 600_000 sits between them — above the parent's own wait
   * ceiling, half of the example — and it must also stay above a normal
   * child turn's duration, or the section becomes wallpaper in every parent
   * step.
   *
   * One consistency law, because two clocks could not drift apart silently:
   * the section lists an agent only when `runningElapsedMs(entry)` is at least
   * this threshold, and `list_agents` reports that SAME number as
   * `elapsed_ms` — so a listed agent's own row can never say it has been
   * running for less. A host that changes one path's clock must change
   * `runningElapsedMs`, which is both readers' single source. */
  subagentStaleAfterMs?: number
}

/** M42 G1: the rewind slice of an assembly — the host (run.ts / the web
 * service) builds a RewindService over these for the rewind surface. */
interface RewindAssemblyHandle {
  store: RewindStore
  recorder: RewindRecorder
}

export interface SessionAssembly {
  ctx: PluginContext // host wires approval/question answerers here (via onAssembly)
  agent: Agent // the per-session agent; tier-1 turns flow through it
  session: Session // the live session — the source of truth
  sessionId?: string
  model: ModelClient // R-B1: NOT the resolved client — the ONE stable handle the six handle-reachable holders share (the two CONFIGURED holders win over it; the service's memoised binding is a reporter). Its identity never changes; its `stream` forwards to the assembly's CURRENT client. The owner reads it at call time (e.g. auto-title, run.ts:697).
  /** Swap the client this assembly's handle forwards to. Every HANDLE-REACHABLE
   * holder follows — they all hold this same object. It is deliberately NOT the
   * whole model surface: a CONFIGURED `summarizationModel` and a configured
   * `guardian.model` win over the handle and keep billing their own endpoint,
   * and the service's memoised binding is refreshed by
   * `SessionService.rebindModel`, not by this call. Identity of `model` does NOT
   * change, which is deliberate: a rebind is one assignment, never a re-wiring. */
  setModel(client: ModelClient): void
  /** Task 4 review F-1: the effort half of the live model surface. A SIBLING of
   * `setModel` rather than an optional second parameter on it, deliberately:
   * `undefined` here means "the new selection names no effort — clear it", and
   * that meaning cannot ride on `setModel(client)` without silently turning every
   * existing call into a clear. `setModel`'s meaning is unchanged. The agent's
   * deps read the effort through a getter, so the next request carries it. */
  setReasoningEffort(effort: ReasoningEffort | undefined): void
  modelLabel?: string
  inbox: Inbox // the per-session serial lane's inbox (owner builds the A executor over it)
  telemetry?: Telemetry
  /** Request cancellation of one background job through the subagent job
   * registry (the model-facing job_kill machinery). */
  killJob(jobId: string): "cancellation-requested" | "already-finished"
  /** M49 Task 12 (spec §8.2): the REAL task projection — subagent rows (live
   * agent-table entries fused with their durable task records, plus
   * record-only recovered rows), job rows (the subagent jobs registry) and
   * workflow rows ONLY when this assembly's workflow executor owns them.
   * Never fabricated: an empty list means literally nothing running. */
  tasks(): AgentTaskView[]
  /** M49 Task 12: cancel ONE task by its stable id THROUGH THE OWNING
   * registry — an agent path aborts the live entry + kills its job (the
   * interrupt_agent/job_kill machinery); a `workflow-` id routes to the
   * workflow executor's killJob; everything else is the jobs registry's
   * kill (job_kill). Unknown ids reuse the registry not-found semantics
   * ("unknown task/job"); terminal ids answer "already-finished". */
  cancelTask(id: string): "cancellation-requested" | "already-finished"
  /** M33 §5: manual compaction surface — binds the agent's compaction seam
   * (no engine configured → { compacted: false } fallback). `instructions` are
   * forwarded to the summarizer prompt ("User instructions" section; absent →
   * pre-M33 prompt). */
  compactNow(instructions?: string): Promise<CompactionResult>
  /** Per-server mount outcome of the plugin MCP servers (serverName → success). */
  pluginMcpResults: Map<string, boolean>
  /** Per-role outcome of the plugin subagent roles (role name → registered).
   * false means the name was already taken and the role was SKIPPED. */
  pluginAgentResults: Map<string, boolean>
  /** M42 G1: rewind engine handle — present only when the host supplied
   * rewindStoreRoot (with a sessionId) AND the journal is not bound to another
   * workspace (M54 G3 mismatch → rewind stays off, "not enabled"). */
  rewind?: RewindAssemblyHandle
  /** Best-effort teardown: reverse-order unmount of mcp/lsp/teams/skills/
   * workflow, terminal dispose, win32 ACL sandbox dispose. NEVER closes the
   * coordinator or the telemetry stream — the owner owns those. Never throws. */
  dispose(): Promise<void>
}

// M33 §3.2: the assembly's scheduling-only overhead estimate — the SAME
// chars/4 estimator family the meter uses (`approxTokens` — ceil(chars/4)) for
// the two pieces the session log NEVER carries but the model sees on every
// request: the (possibly composed) system prompt and the tool schemas' JSON.
// Documented as an estimate, NOT a wire price — it exists so the M20 budget
// ladder and the M11 pressure gate charge something for prompt+schemas when
// the host supplies no exact value.
function estimateAssemblyOverhead(systemPrompt: string, schemas: unknown): number {
  return approxTokens(systemPrompt) + approxTokens(JSON.stringify(schemas))
}

/** M56 T1.5 + M57 T1/T2: bind the provider's fail-soft refresh-failure signal to
 *  the mcp/server-status sink. The failure does NOT change the lifecycle — the
 *  stored token is kept and the 401/M53 reconnect path owns recovery — so the
 *  detail rides in the additive `authRefreshFailed` field instead of overloading
 *  `lastError`. `currentState` reports the server's REAL lifecycle state (a
 *  hardcoded "ready" is only accidentally right); the `"ready"` fallback covers
 *  only a server that has not emitted any state yet. A host-supplied
 *  `hostHandler` is COMPOSED (not overwritten): it runs first and its throw is
 *  swallowed into `onHostError` — a broken host handler must never silence our
 *  visibility event. */
const bindAuthRefreshStatus =
  (
    serverName: string,
    onStatus: (ev: McpServerStatusEvent) => void,
    opts?: {
      currentState?: () => McpServerState | undefined
      /** Prefer a synchronous handler; a returned thenable that rejects is routed
       *  to `onHostError` rather than escaping as an unhandledRejection. */
      hostHandler?: (message: string) => unknown
      onHostError?: (err: unknown) => void
    },
  ) =>
  (message: string): void => {
    try {
      const result = opts?.hostHandler?.(message)
      // An `async` handler rejects on a microtask — invisible to this try/catch
      // (and to the provider's own guard); attach a rejection handler so it can
      // never surface as a process-level unhandledRejection.
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
        void Promise.resolve(result).catch((err) => {
          try { opts?.onHostError?.(err) } catch { /* reporting must not silence the event */ }
        })
      }
    } catch (err) {
      // The reporter's own throw is swallowed too — emitting the event is the point.
      try { opts?.onHostError?.(err) } catch { /* reporting must not silence the event */ }
    }
    // Defensive-only and UNFALSIFIABLE BY CONSTRUCTION (M1 Phase B Task 5 ruling, 2026-09-15): through this assembly `currentState` is a Map lookup that cannot throw.
    let state: McpServerState | undefined
    try { state = opts?.currentState?.() } catch { /* unreachable here: `prepareMcpConfig` passes `mcpStates.get(...)`; a test-only seam was ruled against */ }
    onStatus({ server: serverName, state: state ?? "ready", authRefreshFailed: message })
  }

export async function createSessionAssembly(opts: AssemblyOptions): Promise<SessionAssembly> {
  // Resolve before mounting resources so a required-but-missing model cannot
  // leave a partially initialized assembly behind.
  //
  // R-B1: ONE stable handle, ONE mutable target. The SIX holders that follow it
  // — the agent's deps, the compaction engine (its construction-time copy and its
  // own read are ONE consumer), the subagent tools, the guardian's INHERITED
  // model, the team scheduler, and auto-title (which reads `assembly.model`
  // itself) — all get the handle: one assignment, and none of them has to be told.
  // Changing the TYPE instead (`model: () => ModelClient`) would have reached the
  // same goal while touching 56 sites (measured — raw `createAgent(` occurrences
  // under `packages/`, this comment's own literal excluded); the handle costs
  // none of those edits and keeps `assembly.model`'s identity stable across a
  // rebind.
  //
  // It does NOT reach everything, and the grouping — not a total, which changes
  // with how you group (the plan's R-B1 ruling) — is the fact: TWO are
  // CONFIGURED and deliberately keep billing their own endpoint (a
  // `summarizationModel` and the guardian's own model, each a `??` that WINS over
  // the handle; see compaction's R-B2 note), and ONE is a REPORTER, not a
  // spender — the service's memoised binding, which a raw `setModel` does not
  // move and `service.rebindModel` refreshes.
  //
  // Design: protocol-selection §4.1 — which said "two consumers" and was measured
  // wrong. See the plan's scope ruling R-B1.
  let currentModel: ModelClient = opts.model ?? (() => {
    if (opts.modelPolicy !== "test-mock") throw new ModelUnavailableError()
    return opts.mockScript === undefined && opts.mockCycles === true
      ? cyclicMockClient([{ role: "assistant", text: "ok" }])
      : createMockClient(opts.mockScript ?? [{ role: "assistant", text: "ok" }])
  })()
  // The SECOND cell of the live model surface (Task 4 review F-1): the resolved
  // selection carries an effort as well as a client, and the effort has exactly
  // the same "read at use, not at construction" need. Before this, the agent's
  // deps held `opts.reasoningEffort` as a plain property, so a live rebind moved
  // the client while the per-request effort stayed frozen — `session/model/set`
  // answered `ready` and the header recorded the new effort, while the wire kept
  // sending the old one. core-agent already reads `deps.reasoningEffort` per
  // request; a getter is all it takes to make that read live (see the deps
  // literal below).
  let currentReasoningEffort: ReasoningEffort | undefined = opts.reasoningEffort
  const model: ModelClient = {
    stream: (request) => currentModel.stream(request),
  }
  const ctx: PluginContext = createContext()
  const tools = createToolRegistry(ctx)

  // ── session: live source of truth + coordinator mirror (write-behind) ──────
  // Created BEFORE the execution environment on purpose: the sandbox policy
  // resolver below re-reads this session's `sandbox/mode` events (and its
  // `policyFloor` is that session's length), so the session has to exist first.
  // Nothing here depends on the mounts.
  const session = opts.session ?? createSession((ev) => {
    if (opts.coordinator === undefined || opts.sessionId === undefined) return
    opts.coordinator.enqueue(opts.sessionId, [ev])
    if (ev.type === "turn/end") void opts.coordinator.flush(opts.sessionId).catch(() => {})
  })

  // ── execution environment + policy ─────────────────────────────────────────
  // D1 (m55): every exec-spawning tool gets the assembly workspace as its
  // default cwd — the fs tools already resolve against it (LSP too, below);
  // without this the shell/PTY ran in the PROCESS cwd, a different tree.
  const shellTimeoutMs = opts.shellTimeoutMs ?? 120_000
  // W10 — THE RELATIONSHIP BETWEEN THESE TWO NUMBERS IS THE FEATURE. A
  // foreground shell call that reaches `shellTimeoutMs` is ABORTED there (the
  // tool's declared `timeoutMs` drives guard-timeout, whose abort kills exec's
  // process tree), and the work is lost mid-flight. `shellBackgroundAfterMs` is
  // the escape hatch: at the threshold the command is handed back as a job id
  // and KEEPS RUNNING. That only works while the threshold is WELL UNDER the
  // deadline — at or above it, the abort wins the race and the promotion never
  // fires, silently reverting to the pre-W10 death. 30_000 against 120_000
  // leaves three quarters of the deadline for the hand-back to happen on a
  // loaded machine; a host that lowers `shellTimeoutMs` must lower this with
  // it (and a host that sets the pair equal has configured the death, not the
  // escape hatch).
  const shellBackgroundAfterMs = opts.shellBackgroundAfterMs ?? 30_000
  // W10 review F1: the comment above protects a READER and the falsification
  // test protects CI — a HOST running the misconfiguration has neither, and the
  // failure it gets is the pre-W10 one: every long foreground command dies at
  // the deadline with TOOL_TIMEOUT and the escape hatch it asked for never
  // fires. Nothing else can report this: settings has no schema field for either
  // number, the tool call is too late and per-call, and THIS is the only site
  // that holds both RESOLVED values (defaults included) on the composition root
  // every shipped host passes through (CLI, SDK, ACP).
  if (!(shellBackgroundAfterMs > 0)) {
    // `!(x > 0)` on purpose: it catches 0 AND negative AND NaN (a NaN threshold
    // makes setTimeout fire immediately), all of which promote every foreground
    // call the moment it starts.
    console.warn(
      `[i-harness] shellBackgroundAfterMs is ${shellBackgroundAfterMs} (not a positive number), so EVERY foreground bash/pwsh call is promoted to a background job as soon as it starts: the model gets a job id where it expected a result. Set a positive threshold well under shellTimeoutMs (${shellTimeoutMs}ms).`,
    )
  } else if (shellBackgroundAfterMs >= shellTimeoutMs) {
    console.warn(
      `[i-harness] shellBackgroundAfterMs (${shellBackgroundAfterMs}ms) is not under shellTimeoutMs (${shellTimeoutMs}ms), so foreground promotion will NEVER fire: a command that reaches the deadline is still aborted and its work is lost — the pre-W10 death. Lower shellBackgroundAfterMs (default 30_000) or raise shellTimeoutMs (default 120_000); a host that sets the pair this way on purpose has turned the escape hatch off.`,
    )
  }
  // W11: the same two-sided misconfiguration W10's F1 names, one knob over.
  // The relationship cannot be an inequality between two NUMBERS here — there
  // is no deadline to stay under — so the failure modes are the two ends of
  // the value's own domain, and each is silent in its own way:
  //   - not a positive number (0 / negative / NaN, spelled `!(x > 0)` so NaN is
  //     caught): EVERY running child is past the threshold the instant it
  //     starts, so the section says "stale" about a healthy spawn.
  //   - not finite (Infinity): NOTHING is ever past it, and the failure is
  //     invisible — the section is simply never there, which reads exactly
  //     like "no agent needs attention" (the silent degradation W11 forbids).
  // This is the one site holding the RESOLVED value (default included) on the
  // composition root every shipped host passes through, so it is where a host
  // can be told; a comment protects only readers.
  const subagentStaleAfterMs = opts.subagentStaleAfterMs ?? 600_000
  if (!(subagentStaleAfterMs > 0)) {
    console.warn(
      `[i-harness] subagentStaleAfterMs is ${subagentStaleAfterMs} (not a positive number), so EVERY running sub-agent is past the staleness threshold as soon as its run starts: the runtime-context "subagents" section stops being a signal. Set a positive threshold — the default is 600_000 (10 min).`,
    )
  } else if (!Number.isFinite(subagentStaleAfterMs)) {
    console.warn(
      `[i-harness] subagentStaleAfterMs is ${subagentStaleAfterMs} (not finite), so no sub-agent is EVER past it: the runtime-context "subagents" section never renders, and its silence is indistinguishable from "no agent needs attention". Use a finite threshold — the default is 600_000 (10 min).`,
    )
  }
  // M16w final review (win32 composition): the sandbox-local wrapper returns a
  // bare SandboxProvider and DROPS the backend's dispose(), so this compose
  // site keeps the raw backend and tears it down in dispose() — otherwise the
  // ACL temp grants would leak in composed use.
  let winSandbox: (SandboxProvider & { dispose(): void }) | undefined
  if (process.platform === "win32" && opts.sandbox !== undefined && opts.sandbox !== "danger-full-access") {
    const { createWindowsAclSandbox } = await import("@i-harness/sandbox-windows-acl")
    winSandbox = createWindowsAclSandbox({ writableDirs: [opts.workspace], mode: "read-only" })
  }
  const sandboxProvider =
    opts.sandbox === undefined || opts.sandbox === "danger-full-access"
      ? undefined
      : createLocalSandbox({ ...(winSandbox !== undefined ? { windowsAclBackend: winSandbox } : {}) })
  // M16 final-review (C1) → M62: the SERVICE is built once, but the policy is
  // resolved PER CALL instead of once here. `resolve` re-reads the session's LAST
  // `sandbox/mode` event, so a mode change a HOST appends mid-session takes
  // effect on the next call without rebuilding the assembly. (The escalation
  // ladder is a DIFFERENT path and produces no such event: a grant is per-call
  // and transient and the standing mode never moves — spec §3.3 point 1.)
  // NO ENFORCEMENT SITE caches a resolution: the fs write guard, the shell's
  // per-call argv confinement, and the system prompt all read through THIS one
  // resolver. (Task 2 converted the shell; it used to take a mount-time snapshot
  // here, which is what let it and the fs guard disagree about the mode.)
  //
  // The session read is the LIVE one. `policySession` (the documented host-seeded
  // override) wins when supplied — run.ts passes the same object for both — while
  // hosts that pass only `session` (the web service) would otherwise resolve
  // against nothing forever, leaving every mid-session change invisible.
  const sandboxPolicyService =
    opts.sandbox === undefined ? undefined : createSandboxPolicy({ mode: opts.sandbox, workspaceRoot: opts.workspace })
  // RESTORED HISTORY MUST NOT DECIDE THE MODE. A `sandbox/mode` event that came
  // back from persistence records a decision made in an EARLIER run -- possibly an
  // escalation to danger-full-access -- and letting it win would silently enforce
  // that decision over the mode THIS run requested. That is a privilege escalation
  // on resume: `i-harness run --resume X --sandbox read-only` on a session once
  // escalated would run unrestricted. So only events appended AFTER this
  // construction count as this session's decisions.
  //
  // The floor is taken from whichever session will actually be read, because
  // `policySession` may be a different object from the live one. Slicing rather
  // than tracking indices keeps `resolve`'s contract unchanged.
  const policyBase = opts.policySession ?? session
  const policyFloor = policyBase.events.length
  // M1 Phase B: the CONSTRUCTION-TIME producer. Until this line the
  // `sandbox/mode` event had zero production producers -- 14 of its 17
  // occurrences were test `append(…)` calls -- so `effectiveSandboxMode`'s
  // non-default branch could never be taken and a host that stated the mode it
  // was starting under wrote nothing at all. The two session-executor tests
  // already append this event "as a HOST action, not the ladder's", and say so
  // in source; this makes the assembly do what they simulate.
  //
  // Appended AFTER the floor assignment above, so it lands AT the floor index --
  // i.e. INSIDE the `slice(policyFloor)` window the resolver reads -- because it
  // is THIS run's decision and not restored history. (Source order and window
  // order agree here: the floor is a lower bound and this event sits on it, as
  // the newest event in the retained window.) That keeps the resume-escalation
  // guard documented just above intact: restored history still cannot decide the
  // mode. The ladder is still forbidden from producing this event (call-policy.ts
  // documents that; sandbox-escalation.test.ts pins it).
  if (opts.sandbox !== undefined) append(policyBase, { type: "sandbox/mode", mode: opts.sandbox })
  const sandboxPolicyNow = () =>
    sandboxPolicyService?.resolve({ session: { ...policyBase, events: policyBase.events.slice(policyFloor) } })
  // M62: the terminal is mounted HERE, not at the top of the environment,
  // because its tools resolve the sandbox policy PER CALL and the resolver is
  // defined just above. Mount order does not affect disposal — `dispose()`
  // tears the terminal down explicitly by handle, not through the reverse-order
  // mount list. (The comment this replaced claimed the terminal-first order
  // "mirrored runHeadless"; there is no second sequence to mirror —
  // `registerTerminal` has exactly one non-test caller, and `runHeadless` mounts
  // nothing itself.)
  // M62: the escalation ladder's approval ADAPTER, built ONCE here — and only
  // the adapter. It is a pure function of `ctx`, so it can be built at mount
  // time; the per-call `EscalationContext` (which needs the call's `ToolExec`)
  // cannot, and is composed inside each tool body.
  //
  // The lambda is the plain lookup on purpose: the throwing-getter `catch` lives
  // INSIDE `createApprovalEscalationApprover` and is tested there. A second
  // `try/catch` here would be a second place for the fail-closed rule (an
  // unregistered service must never become a silent allow) to drift.
  //
  // The getter is read LAZILY on every request, so a host that registers its
  // answerer after mounting — or not at all — is handled correctly: absent means
  // `"unavailable"`, which the ladder turns into a refusal.
  const escalationApprover = createApprovalEscalationApprover(
    () => ctx.services.get<ApprovalPrompt>("approval/answerer"),
  )
  const terminalMount: TerminalMountHandle = registerTerminal(ctx, tools, {
    cwd: opts.workspace,
    ...(sandboxPolicyService !== undefined ? { sandboxPolicy: sandboxPolicyNow } : {}),
    escalationApprover,
  })
  // M62: the shell gets the RESOLVER, not a value. It used to receive
  // `sandboxPolicyNow()` evaluated here — a mount-time snapshot — so a mode
  // change a HOST appended to the session mid-run reached the fs guard but not
  // the shell, and the two surfaces disagreed about the mode in force. Every
  // call site now invokes this thunk, so `bash`/`pwsh` confine against the policy
  // of THAT call, exactly like the fs write guard — and the terminal above
  // refuses capability-creating calls on the same per-call read.
  //
  // The escalation ladder is NOT such a change and never was: a grant is
  // per-call and transient, appends no `sandbox/mode` event, and never moves the
  // standing mode (spec §3.3 point 1). It reaches a tool through its own
  // arguments and the approver below, not through this resolver.
  registerShell(ctx, tools, {
    timeoutMs: shellTimeoutMs,
    // W10: the pair travels together — the shell layer needs both to keep the
    // threshold under the deadline it declares to guard-timeout.
    backgroundAfterMs: shellBackgroundAfterMs,
    retention: opts.shellRetention ?? { maxBytes: 64_000 },
    cwd: opts.workspace,
    ...(sandboxProvider !== undefined ? { sandbox: sandboxProvider } : {}),
    ...(sandboxPolicyService !== undefined ? { sandboxPolicy: sandboxPolicyNow } : {}),
    escalationApprover,
  })
  // M26-B3: web surface (webfetch + websearch) — no provider → fail closed.
  registerWeb(ctx, tools)
  // M42 G1: rewind engine — Store+Recorder created BEFORE the fs tools (they
  // receive the pre-image sink in their deps). Requires a sessionId (storage
  // keys on it); the recorder subscription is wired below once the live
  // session exists (subscribe is append-onward, so host-seeded history is
  // not recorded — a documented v1 scope).
  let rewindStore: RewindStore | undefined
  let rewindRecorder: RewindRecorder | undefined
  if (opts.rewindStoreRoot !== undefined && opts.sessionId !== undefined) {
    const store = new RewindStore({ root: opts.rewindStoreRoot, sessionId: opts.sessionId, workspace: opts.workspace })
    // M54 G3: verify the journal's workspace binding. A mismatch must NOT
    // block the session (the conversation is not the rewind journal) — it is
    // warned here and every rewind surface op fails closed
    // (REWIND_WORKSPACE_MISMATCH), so a resume from another cwd can never
    // silently restore into the wrong tree.
    // M54 final-review F3: on a MISMATCH, rewind is left entirely OFF — no
    // recorder and no fs pre-image sink (assembly.rewind stays absent, which
    // the host renders as "not enabled"). A wired recorder could never write
    // this journal; it would throw and warn on every fs write for a session
    // whose rewind is permanently dead. Other binding failures (e.g. a corrupt
    // meta.json) keep the previous behavior: the handle is created and the
    // surface fails loud per call.
    let mismatched = false
    try {
      await store.assertWorkspace(opts.workspace)
    } catch (err) {
      mismatched = err instanceof RewindError && err.code === "REWIND_WORKSPACE_MISMATCH"
      console.warn(`[rewind] ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!mismatched) {
      // M54 G2: a turn that crashed mid-flight becomes a durable orphan
      // artifact (never a fabricated point); plan() reports it. Best-effort —
      // a corrupt sidecar must not stop the session from opening (it stays on
      // disk and plan() fails loud on it).
      try {
        const recovered = await store.recoverPending()
        if (recovered !== null) {
          console.warn(
            `[rewind] recovered an unfinished turn (anchor seq ${recovered.anchorSeq}, ${recovered.entries.length} file(s)) as an orphan — plan() reports it`,
          )
        }
      } catch (err) {
        console.warn(`[rewind] pending-turn recovery failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      rewindStore = store
      rewindRecorder = new RewindRecorder({ store, workspace: opts.workspace })
    }
  }
  // M16: the fs tools are IN-PROCESS, so no OS backend can wrap them the way the
  // shell sandbox wraps a spawned command. They were handed `workspace` and
  // nothing else, while `resolvePath` — the thing IH calls fs confinement — skips
  // its escape check for ABSOLUTE inputs by design. So `sandbox: "read-only"`
  // refused `shell` writes and let the `write` tool write anywhere on disk. The
  // policy is now passed down as a write predicate; `checkWrite` mirrors what the
  // OS backends actually enforce (workspace + temp writable, reads untouched) so
  // fs and shell agree rather than one being stricter than the other.
  // M16 → M62: resolve at each call rather than closing over one value. The
  // service was built once; `sandboxPolicyNow()` re-reads the session's last
  // `sandbox/mode` event, so a mode change mid-session reaches the fs tools on
  // their NEXT call. (The read is a reverse scan for that event. NO FIGURE HERE, on
  // purpose: the "0.056-0.125 ms over a 20k-event session, nine samples" this comment
  // used to quote was WITHDRAWN by the M62 final review — nothing in the repo
  // reproduces it, and the test guarding the cost is a ceiling (~20x on a quiet
  // machine), not a detector. Spec §7 records the withdrawal and the measured
  // spread; the decision it supported stands: no cache, and no invalidation rule to
  // get wrong, until a measurement says otherwise.)
  // M62: the refusal is converted HERE, at the one place that knows the policy,
  // into the shared `SandboxDenial` — `checkWrite` stays a pure path decision.
  //
  // `modeOverride` is the escalation grant: the tool body resolves the ladder
  // ONCE per call and hands the granted mode down, so the check judges the
  // operation under the mode the user approved. Two consequences the body of
  // this closure keeps in one place:
  //  - the denial names the mode the CHECK USED (`effective.mode`), never the
  //    session's. A model told "refused under read-only" right after obtaining
  //    `workspace-write` retries forever against a mode it is no longer in, and
  //    the escalation hint derived from that mode would name the wrong next step;
  //  - the base policy is the SAME thunk the tools receive (`sandboxPolicyNow`),
  //    so the mode the ladder escalates FROM is read from the same events as the
  //    mode this guard checks. CORRECTED 2026-09-15 (final review, Scope C F10):
  //    that is true of the THUNK, not of the READ — the ladder reads the policy
  //    and the guard reads it again, with an `await` between them, so if a host
  //    appended a `sandbox/mode` event while an approval prompt was open the
  //    strictly-wider check would have been made against the older mode. No such
  //    host exists today, and the REASON changed on 2026-09-15: this comment used to
  //    say "nothing in production appends the event", which the construction-time
  //    producer above (`:354`, M1 Phase B) made false. The surviving reason is
  //    narrower and still true: that producer runs at CONSTRUCTION only, so no host
  //    can append an event *while a prompt is open*.
  //  - the refusal names the mode that would LIFT it (`decision.sufficientMode`),
  //    not the first strictly-wider one: for an out-of-workspace target under
  //    `read-only` those differ, and naming the wider one sent the model to a
  //    retry that failed identically. That was the terminal's bug class on fs.
  const writeGuard =
    sandboxPolicyService === undefined
      ? undefined
      : (abs: string, modeOverride?: SandboxMode) => {
          const policy = sandboxPolicyNow()
          if (policy === undefined) return { ok: true as const }
          const effective = modeOverride === undefined ? policy : { ...policy, mode: modeOverride }
          const decision = checkWrite(effective, abs)
          return decision.ok
            ? { ok: true as const }
            : { ok: false as const, denial: denialFor("fs", effective.mode, decision.reason, decision.sufficientMode) }
        }
  const fsToolsDeps = {
    workspace: opts.workspace,
    ...(rewindRecorder !== undefined
      ? { rewind: { take: (path: string, before: Uint8Array | null) => rewindRecorder.take(path, before) } }
      : {}),
    ...(writeGuard !== undefined ? { writeGuard } : {}),
    // The ladder's base read — the SAME thunk the guard closes over, so the
    // mode a request escalates FROM is the mode the granted operation is judged
    // under. A second resolver here could evaluate `approveEscalation`'s
    // strictly-wider test against one mode and the operation against another.
    ...(sandboxPolicyService !== undefined ? { sandboxPolicy: sandboxPolicyNow } : {}),
    escalationApprover,
  }
  for (const tool of createFsTools(fsToolsDeps)) tools.register(tool)
  createApprovalPolicy(ctx, tools, { workspace: opts.workspace })

  // M10a guards + M12 retry (retry MUST mount BEFORE timeout — cascade order,
  // first registered = outermost) + M26-B7 registry-level output spill
  // (spill outermost so it sees the largest unprocessed output).
  if (opts.outputSpill) ctx.mount(createOutputSpillGuard(ctx, opts.outputSpill))
  if (opts.retry) ctx.mount(createRetryGuard(ctx, opts.retry))
  ctx.mount(createTimeoutGuard(ctx))
  ctx.mount(createRepeatToolGuard(ctx))

  // Approval: approveAll → auto-approve; otherwise NO answerer — the host
  // wires the real one (mux approval bridge) through assembly.ctx; unanswered
  // approvals fail closed (guard-approval default).
  if (opts.approveAll) {
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
  }
  // M26-B14: ask_user_input tool — registered unconditionally; a host without
  // a question provider gets NO_PROVIDER (fail-closed).
  registerAskUserInput(ctx, tools)

  registerToolSearch(ctx, tools)
  const skillsMount = registerSkills(ctx, tools, {
    workspace: opts.workspace,
    ...(opts.skills?.extraDirs !== undefined ? { extraDirs: opts.skills.extraDirs } : {}),
  })
  const execService = ctx.services.get<ExecService>("exec/service")
  for (const tool of createFsSearchTools({ exec: execService, workspace: opts.workspace })) tools.register(tool)
  if (opts.sessionQuery) {
    for (const tool of createSessionQueryTools(opts.sessionQuery)) tools.register(tool)
  }

  // ── session: coordinator mirror (write-behind) ─────────────────────────────
  // `session` itself is created at the top of the function — the sandbox policy
  // resolves against its events per call, so it has to exist before the mounts.
  const inbox = new Inbox(session)
  // M42 G1: recorder subscription — the turn's anchor is its first
  // user/message (begin, first-wins — a mid-turn spliced message must not
  // re-anchor), turn/end finalizes + appends the durable point. Finalize is
  // detached: the rewind journal is a backend concern — a failure must never
  // break the live agent loop (warn only; the turn completes regardless).
  let rewindSubscription: (() => void) | undefined
  let rewindDrain: Promise<void> = Promise.resolve()
  if (rewindRecorder !== undefined && rewindStore !== undefined) {
    const recorder = rewindRecorder
    const store = rewindStore
    rewindSubscription = subscribe(session, (ev) => {
      if (ev.type === "user/message") {
        recorder.begin(ev.seq ?? 0, ev.text)
      } else if (ev.type === "turn/end") {
        // Snapshot immediately so the next turn can begin while journal I/O
        // remains serialized and tracked for shutdown.
        const finalized = recorder.finalize()
        rewindDrain = rewindDrain.then(async () => {
          const point = await finalized
          if (point === null) return
          // Finalization may overlap a prior append; commit at the current
          // journal frontier while this chain owns the append slot.
          const committed = { ...point, turnIndex: (await store.readPoints()).length }
          await store.appendPoint(committed)
          // M54 G2: only now is the turn durable — clear its pending sidecar
          // (a crash in between is recognised by recoverPending via the point).
          await recorder.commit(committed.anchorSeq)
        }).catch((err) => {
          console.warn(`[rewind] point append failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    })
  }
  // M27-R-A8: context budget tool — registered against the live session (the
  // M15 projection source) only when the composition supplied a window.
  registerContextRemaining(ctx, tools, { contextWindow: opts.contextWindow, session })

  // M40 A1/B8: session-scoped tools — todo_write (M21 whole-list snapshot,
  // model-visible via todo/write events) + read_image (M14 multimodal read:
  // workspace-resolved path → ImageInput { mediaType, dataBase64 }).
  tools.register(createTodoTool({ session }))
  tools.register(createReadImageTool({ workspace: opts.workspace }))

  // E9 schedule (spec 2026-09-20-schedule-design §4.2/§4.6): the delivery mount. Gated on the
  // DURABLE path — coordinator + sessionId — because the acceptance contract IS "dispatch +
  // admission in one durable batch", and without a coordinator there is no batch to speak of.
  // The gate ASSUMES the session is already mirrored (its own appends must reach this
  // coordinator): the mirror is installed here only when this assembly CREATES the session —
  // with a caller-supplied session it is the caller's job, and both in-repo hosts do it
  // (apps/cli/src/run.ts:310-313, packages/session-executor/src/durable-session.ts:12-15).
  // Without a mirror `coordinator.flush` is a no-op (session-persistence/src/index.ts:579-582)
  // and the durability half of that claim would be false.
  // Tools and driver mount together: tools alone would be a fifth zero-source (writes the log,
  // nothing folds it — spec §10).
  if (opts.coordinator !== undefined && opts.sessionId !== undefined) {
    const coordinator = opts.coordinator
    const scheduleSessionId = opts.sessionId
    for (const tool of createScheduleTools({ session })) tools.register(tool)
    const scheduleDriver = createScheduleDriver({
      sessions: () => [scheduleSessionId],
      // Fork (§5): the driver owns only THIS session's own suffix — an inherited prefix
      // (subagent seeds) is never dispatched; the same slice task-protocol.ts:355 takes.
      events: (id) => (id === scheduleSessionId ? session.events.slice(session.header?.seedLength ?? 0) : undefined),
      deliver: async (delivery) => {
        // §3.4 (corrected): the canonical append() path (seq + write-behind mirror + subscribers)
        // for BOTH events, then the flush barrier — the pair lands in ONE backend append, and
        // `deliver` returns only after durability. The engine does not write; this does.
        // ORDER is load-bearing: dispatch BEFORE admission (an `admit` throw — a duplicate
        // still-pending id; not reachable today — would leave the record consumed without a
        // delivered input). And a flush throw is NOT "nothing accepted": both events are already
        // in memory (the fold consumed the dispatch; the next step boundary claims the admission,
        // so the user sees the reminder) while the write-behind retains & retries the batch —
        // `deliveryErrors` is a durability report, not a refusal.
        for (const ev of delivery.dispatchEvents) append(session, ev)
        inbox.admit({ inputId: delivery.inputId, text: delivery.text, delivery: "steer", intent: "system" })
        await coordinator.flush(scheduleSessionId)
      },
    })
    // §4.2: the trigger is the step boundary — no timer exists, so idle means no step means no
    // tick (I5 structurally). The handler MUST return undefined (block body, awaited inside):
    // emit() feeds a plain listener's non-undefined return into the waterfall chain payload, and
    // hooks HAS a waterfall on this same event (hooks/src/index.ts:411).
    ctx.on("agent/pre-step", async () => { await scheduleDriver.tick() })
  }

  // R-A4/R-A5: dynamic system context — sections render at every step boundary
  // via the agent/pre-step hook. Instructions load as one section; W11 adds a
  // second one below, once the subagent mount has produced the table it reads.
  const runtimeContext = installRuntimeContext(ctx, session)
  runtimeContext.registerSection(
    "instructions",
    createInstructionsSection({ workspace: opts.workspace }),
  )

  // M26-B1: OAuth token store over the coordinator's document API (see run.ts;
  // the coordinator contract reports, never rejects → worst case re-auth).
  const coordinatorTokenStore = (coordinator: SessionCoordinator): McpTokenStore => {
    const key = (k: string) => `mcp-oauth:${k}`
    return {
      get: (k) => coordinator.getDocument(key(k)),
      put: (k, data) => coordinator.putDocument(key(k), data),
    }
  }
  // M57 T1: last emitted lifecycle state per server, so a refresh-failure event
  // can carry the server's real state. Written by mcpStatusHook (declared first,
  // and the only writer), read lazily by the binder.
  const mcpStates = new Map<string, McpServerState>()
  const mcpStatusHook = (ev: McpServerStatusEvent): void => {
    mcpStates.set(ev.server, ev.state)
    opts.telemetry?.emit({ type: "mcp/server-status", ts: Date.now(), data: { ...(ev as unknown as Record<string, unknown>) } })
  }
  // M56 T1.5: the auth config object flows UNCHANGED through mountMcpClient →
  // supervisor → deps.connect → createConnectedClient → provider, so binding the
  // provider's refresh-failure signal here is the whole wiring (no supervisor or
  // connect signature change). The event is additive (`authRefreshFailed`).
  // M57 T1/T2: with telemetry ON, mcpStatusHook is the supervisor's onStatus, so
  // the map's first write is the supervisor's "connecting" and the binder's
  // "ready" fallback is unreachable; with telemetry OFF the hook is never
  // registered as onStatus, so the map is fed ONLY by refresh-failure events
  // themselves — every event then reports the "ready" fallback (the emit is a
  // no-op without telemetry). A host-supplied handler is forwarded, never clobbered.
  const prepareMcpConfig = (cfg: McpServerConfig): McpServerConfig => {
    if (cfg.transport !== "streamable-http" || cfg.auth === undefined) return cfg
    const auth: McpOAuthConfig = {
      ...cfg.auth,
      onAuthRefreshFailed: bindAuthRefreshStatus(cfg.serverName, mcpStatusHook, {
        currentState: () => mcpStates.get(cfg.serverName),
        ...(cfg.auth.onAuthRefreshFailed !== undefined ? { hostHandler: cfg.auth.onAuthRefreshFailed } : {}),
        onHostError: (err) => {
          console.warn(
            `[i-harness] mcp-server(${cfg.serverName}) OAuth: host onAuthRefreshFailed handler threw (${err instanceof Error ? err.message : String(err)}); visibility event still emitted`,
          )
        },
      }),
      ...(cfg.auth.store === undefined && opts.coordinator !== undefined
        ? { store: coordinatorTokenStore(opts.coordinator) }
        : {}),
    }
    return { ...cfg, auth }
  }

  const mcpHandles: McpMountHandle[] = []
  const lspHandles: LspMountHandle[] = []
  const teamHandles: TeamMountHandle[] = []
  let workflowMount: WorkflowMountHandle | undefined

  try {
    for (const cfg of opts.mcp ?? []) {
      mcpHandles.push(await mountMcpClient(ctx, tools, prepareMcpConfig(cfg), opts.telemetry ? { onStatus: mcpStatusHook } : undefined))
    }
    // Plugin MCP servers — per-server containment (live-agent precedent): a
    // server this host cannot serve degrades to a warn; the result map reports.
    const pluginMcpResults = new Map<string, boolean>()
    for (const cfg of opts.pluginMcp ?? []) {
      try {
        mcpHandles.push(await mountMcpClient(ctx, tools, prepareMcpConfig(cfg), opts.telemetry ? { onStatus: mcpStatusHook } : undefined))
        pluginMcpResults.set(cfg.serverName, true)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.warn(`[i-harness] plugin MCP server "${cfg.serverName}" failed to mount (skipped for this agent): ${reason}`)
        pluginMcpResults.set(cfg.serverName, false)
      }
    }
    // M6-D3: the catalogue's rebuild boundary. A server that announced
    // `notifications/tools/list_changed` has its catalogue rebuilt HERE — at the
    // step boundary, never inside the notification callback — and the rebuild is
    // in place (the current generation is re-drained; no reconnect). The handler
    // MUST return undefined (block body, awaited inside): emit() feeds a plain
    // listener's non-undefined return into the waterfall chain payload, and this
    // very event has a waterfall when a host mounts hooks. It also must not
    // throw: a background catalogue refresh is not on the turn's critical path
    // (the schedule driver's tick() above is the precedent), so a failure is
    // REPORTED and the flag stays dirty — the next boundary tries again.
    // Registered after BOTH MCP loops; `mcpHandles` is typed McpMountHandle[],
    // so the lsp/team handles (separate arrays) are never asked these questions.
    for (const mcpHandle of mcpHandles) {
      ctx.on("agent/pre-step", async () => {
        if (!mcpHandle.catalogDirty()) return
        try {
          await mcpHandle.refreshCatalog()
        } catch (err) {
          console.warn(
            `[i-harness] mcp-server(${mcpHandle.serverName}) catalogue refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      })
    }
    for (const cfg of opts.lsp ?? []) {
      lspHandles.push(await mountLspClient(ctx, tools, { ...cfg, cwd: cfg.cwd ?? opts.workspace }))
    }
    workflowMount = registerWorkflow(ctx, tools, { workspace: opts.workspace, exec: execService })
    // ONE resolver for every role-carrying spawn in this assembly: the subagent
    // tools, the approval guardian and team teammates all hand their role's
    // selection to the host's provider plane — the same runtime call the
    // session's own binding made. The fallback names the selection the host
    // asked about, so a missing wiring is heard at the first such spawn.
    const resolveRoleModel: NonNullable<AssemblyOptions["resolveRoleModel"]> = opts.resolveRoleModel ?? (async (selection) => ({
      status: "unconfigured" as const,
      reason: `no role-model resolver is configured (role asked for ${selection.provider}:${selection.model})`,
    }))
    const subagent = registerSubagent(ctx, tools, {
      resolveModel: resolveRoleModel,
      // The gate travels with the resolver it gates, into THIS chain:
      // RegisterSubagentOptions → SubagentToolDeps → spawnChild. The guardian
      // and team call sites below are handed the same two options — a site that
      // got the resolver without them would resolve nothing and inherit,
      // silently. Both are omitted when the host passed neither: an unset
      // switch is OFF, never "enabled by omission".
      ...(opts.roleSelectionFor !== undefined ? { roleSelectionFor: opts.roleSelectionFor } : {}),
      ...(opts.allowSubagentModelSelection !== undefined ? { allowSubagentModelSelection: opts.allowSubagentModelSelection } : {}),
      exec: execService,
      parentModel: model,
      parentSession: session,
      workflow: workflowMount.executor,
      ...(opts.coordinator !== undefined && opts.sessionId !== undefined
        ? {
            persist: {
              coordinator: opts.coordinator,
              stateId: opts.sessionId,
              parentSessionId: opts.sessionId,
              ...(opts.jobStatusEvents === true ? { parentSession: session } : {}),
            },
          }
        : {}),
      ...(opts.restoredState !== undefined ? { restoredState: opts.restoredState } : {}),
      ...(opts.parentNotify !== undefined ? { parentNotify: opts.parentNotify } : {}),
    })
    // W11 — the unasked path, registered HERE because this is the first point
    // that holds both the runtime-context service and the agent table the
    // section reads (`subagent.table`, which is the persistence-wrapped table
    // the tools write, so the section sees the same entries they do).
    //
    // Nothing below starts a turn: the getter runs at `agent/pre-step` — a
    // step the session is already taking — and the section's text is a
    // function of the SET of children past `subagentStaleAfterMs` (paths,
    // role/job, the constant threshold), never of the ticking elapsed, so
    // runtime-context's change-only append yields one log line per crossing
    // and one per leaving. See `createStaleSubagentsSection`.
    runtimeContext.registerSection(
      "subagents",
      createStaleSubagentsSection({ table: subagent.table, thresholdMs: subagentStaleAfterMs }),
    )
    // Plugin subagent roles. AFTER registerSubagent on purpose: that call is
    // where the snapshot's roles are restored and where the persistence wrapper
    // replaces `subagent.roles`, so registering here means the role is saved on
    // register and cannot shadow a restored, user-edited role. `get`-then-
    // register rather than try/catch, mirroring the tool loop above: a taken
    // name is skipped, and RoleRegistry.register's duplicate throw is never
    // used as control flow.
    const pluginAgentResults = new Map<string, boolean>()
    for (const role of opts.pluginAgents ?? []) {
      const free = subagent.roles.get(role.name) === undefined
      if (free) subagent.roles.register(role)
      pluginAgentResults.set(role.name, free)
    }
    if (opts.guardian) {
      await registerGuardian(ctx, {
        subagents: {
          roles: subagent.roles,
          jobs: subagent.jobs,
          table: subagent.table,
          agents: subagent.agents,
        },
        parentRegistry: tools,
        parentSession: session,
        parentCtx: ctx,
        resolveModel: resolveRoleModel,
        // The gate travels with the resolver it gates (rule stated at the
        // registerSubagent chain above): THIS spawn site is role-carrying too.
        ...(opts.roleSelectionFor !== undefined ? { roleSelectionFor: opts.roleSelectionFor } : {}),
        ...(opts.allowSubagentModelSelection !== undefined ? { allowSubagentModelSelection: opts.allowSubagentModelSelection } : {}),
        parentModel: model,
        ...(opts.guardian.model !== undefined ? { model: opts.guardian.model } : {}),
        ...(opts.guardian.policy !== undefined ? { policyText: opts.guardian.policy } : {}),
        ...(opts.guardian.timeoutMs !== undefined ? { timeoutMs: opts.guardian.timeoutMs } : {}),
        ...(opts.coordinator !== undefined && opts.sessionId !== undefined
          ? {
              breaker: { coordinator: opts.coordinator, sessionId: opts.sessionId },
              childSessions: { coordinator: opts.coordinator, parentSessionId: opts.sessionId },
            }
          : {}),
      })
    }
    // Await BEFORE mounting agent teams (recoverRoot delivers queued team
    // messages to entry.session — mirrors must be live first).
    await subagent.ready
    if (opts.team !== undefined) {
      teamHandles.push(await mountAgentTeams(ctx, tools, {
        parentSession: session,
        parentRegistry: tools,
        subagents: {
          table: subagent.table,
          jobs: subagent.jobs,
          roles: subagent.roles,
          agents: subagent.agents,
          exec: execService,
          resolveModel: resolveRoleModel,
          // The gate travels with the resolver it gates — same rule, same two
          // options as the other spawn sites above.
          ...(opts.roleSelectionFor !== undefined ? { roleSelectionFor: opts.roleSelectionFor } : {}),
          ...(opts.allowSubagentModelSelection !== undefined ? { allowSubagentModelSelection: opts.allowSubagentModelSelection } : {}),
          childSessions:
            opts.coordinator !== undefined && opts.sessionId !== undefined
              ? { coordinator: opts.coordinator, parentSessionId: opts.sessionId }
              : undefined,
          ensureResident: subagent.ensureResident,
        },
        parentModel: model,
      } satisfies TeamDeps, opts.team))
    }

    // M49 Task 14 (spec §11): the base system prompt is the I-harness-owned
    // DEFAULT_AGENT_PRESET (readable source in @i-harness/preset) when the
    // host supplied no override; an explicit preset override stays
    // authoritative (parsePreset validates name/systemPrompt/tools — a host
    // preset must satisfy the same contract). Plan-mode/sandbox fragments are
    // composed ON TOP (the default prompt never overrides those).
    let baseSystemPrompt = opts.preset !== undefined
      ? parsePreset(opts.preset).systemPrompt
      : DEFAULT_AGENT_PRESET.systemPrompt
    if (opts.planMode) baseSystemPrompt = `${baseSystemPrompt}\n\n${PLAN_MODE_SYSTEM_PROMPT}`
    // The fragment says "Current", so it must BE current. Both the guards and
    // this prompt read `sandboxPolicyNow()`, but the guards read it per CALL and
    // the prompt is re-read per STEP — so a mid-session mode change moves both,
    // and neither can describe a mode the other is not enforcing. Composed once
    // per distinct mode: unchanged mode → identical string → stable prefix.
    // The resolution happens ONCE per call here: one local, read for both the
    // memo comparison and the render, so a mode that flipped between two reads
    // could never be memoised under the wrong key.
    let promptCache: { mode: SandboxMode | undefined; text: string } | undefined
    const systemPromptNow = (): string => {
      const policy = sandboxPolicyNow()
      const mode = policy?.mode
      if (promptCache !== undefined && promptCache.mode === mode) return promptCache.text
      const text = policy === undefined ? baseSystemPrompt : `${baseSystemPrompt}\n\n${renderPolicyContext(policy)}`
      promptCache = { mode, text }
      return text
    }

    // M33 §3.2: when the window is resolved and the host did not supply an
    // overhead, the assembly supplies the estimate into BOTH count surfaces
    // (M11 compact config — host's explicit overheadTokens always wins — and
    // the M20 budget ladder).
    const overheadEstimate = opts.contextWindow === undefined
      ? undefined
      : estimateAssemblyOverhead(systemPromptNow(), tools.schemas())

    // M11/M31 T3: the engine needs a window, and the assembly is the layer that
    // resolved one. When a caller asked for compaction but no window is available,
    // the request CANNOT be honoured — and the honest response is to say so. The
    // previous code passed `opts.compact` through unchanged in that case, which
    // meant a config without the field the engine requires; the CLI, meanwhile,
    // never set `compact` at all, so in practice layer 1 of the budget ladder was
    // dead everywhere and long sessions fell to the fail-closed `prompt_too_long`.
    // A silent drop would be the same class of bug wearing a different hat.
    // The window may arrive two ways and both are legitimate: the assembly's own
    // `contextWindow` (resolved from the model binding), or one the host put
    // directly in the compact config. The assembly's value wins when both exist;
    // the config's is the fallback. Requiring only the first would break callers
    // that already supply the second — a regression the assembly tests caught.
    const compactWindow = opts.contextWindow ?? opts.compact?.contextWindow
    let compactForAgent: CompactionConfig | undefined
    if (opts.compact !== undefined) {
      if (compactWindow !== undefined) {
        compactForAgent = {
          ...opts.compact,
          contextWindow: compactWindow,
          ...(opts.compact.overheadTokens === undefined && overheadEstimate !== undefined ? { overheadTokens: overheadEstimate } : {}),
        }
      } else {
        console.warn(
          "[i-harness] compaction was requested but no context window could be resolved, so auto-compaction is DISABLED for this session. " +
            "Pressure will not trigger a summary; once the budget is exhausted the turn will be refused with prompt_too_long instead. " +
            "Supply `contextWindow`, put one in the compact config, or use a model binding that carries one.",
        )
      }
    }

    const agent = createAgent(ctx, {
      session, tools, model,
      systemPrompt: systemPromptNow,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(compactForAgent !== undefined ? { compact: compactForAgent } : {}),
      // M31 T3: AgentBudgetConfig.contextWindow is required — supply only when
      // a window was resolved (absent → no budget → pre-M20 behavior).
      ...(opts.contextWindow !== undefined && overheadEstimate !== undefined
        ? { budget: { contextWindow: opts.contextWindow, overheadTokens: overheadEstimate } }
        : {}),
      ...(opts.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: opts.maxParallelToolCalls } : {}),
      ...(opts.telemetry !== undefined ? { telemetry: opts.telemetry } : {}),
      // M32 T3, made live (Task 4 review F-1): a GETTER, not the construction
      // value — the same discipline as the model handle above (R-B1). core-agent
      // reads `deps.reasoningEffort` when it builds each request
      // (core-agent/src/index.ts — "verbatim effort passthrough"), so a rebind
      // reaches the wire without core-agent knowing a cell exists.
      get reasoningEffort() { return currentReasoningEffort },
      // R-A1: steer-tier claims at the step boundary (mid-turn injection).
      stepInputs: { claimAtStepBoundary: () => inbox.claimAtStepBoundary() },
    })
    if (opts.planMode) ensurePlanModeTool(tools, session)

    return {
      ctx,
      agent,
      session,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      model,
      // R-B1: the model surface's mutations — TWO of them, and they are a PAIR
      // (F-1 added the second). Nothing in these types ties the two together, so
      // what keeps them paired is this description. The handle above keeps its
      // identity, so every handle-reachable holder that captured it — the agent's
      // deps, the compaction engine, the subagent tools, the guardian's INHERITED
      // model, the team scheduler, auto-title (the six of the R-B1 note above)
      // — follows a `setModel` without being told.
      setModel: (client) => { currentModel = client },
      // The second half of the pair, and the PAIRING IS THE INVARIANT: nothing
      // in these types forces the two calls to happen together. A rebind that
      // goes through `setModel` alone leaves the effort frozen on the previous
      // selection — the regression F-1 fixed; a description of the surface that
      // names only ONE mutation is how it comes back. The service's
      // `rebindModel` is the one production caller and installs BOTH from a
      // single resolved binding, so the two cells cannot disagree.
      setReasoningEffort: (effort) => { currentReasoningEffort = effort },
      ...(opts.modelLabel !== undefined ? { modelLabel: opts.modelLabel } : {}),
      inbox,
      ...(opts.telemetry !== undefined ? { telemetry: opts.telemetry } : {}),
      killJob: (jobId: string) => subagent.jobs.kill(jobId),
      // M49 Task 12: the projection owns NO registry object — rows only. The
      // workflow group comes from THIS workflow executor's real store rows
      // (mounted unconditionally above — the non-null claim is the mount
      // ordering) FILTERED to the runs THIS session started (the workflow_run
      // tool attributes each run to its calling session id; runs started
      // outside a session — the run-level /workflow panel — are attributed to
      // no session and belong to that panel's surface, so a session's
      // projection never shows another session's workflow jobs).
      tasks: () => [
        ...subagent.projectTasks(),
        ...projectWorkflowRows(workflowMount!.executor.listJobs(), opts.sessionId),
      ],
      // Cancellation routes by owner: agent path → the live entry's abort
      // channel + its job kill (interrupt_agent/job_kill parity — the two
      // cannot disagree); `workflow-` ids → the workflow store's killJob;
      // everything else → the jobs registry's kill (job_kill). Unknown ids
      // propagate the registry's "unknown job/task" error — never a silent
      // success; terminal ids answer already-finished.
      cancelTask: (id: string): "cancellation-requested" | "already-finished" => {
        const entry = subagent.table.get(id)
        if (entry !== undefined) {
          if (entry.status !== "running") return "already-finished"
          entry.controller.abort()
          return entry.jobId !== undefined ? subagent.jobs.kill(entry.jobId) : "cancellation-requested"
        }
        if (id.startsWith("workflow-")) return workflowMount!.executor.killJob(id)
        return subagent.jobs.kill(id)
      },
      compactNow: async (instructions?: string) =>
        agent.compact?.(instructions) ?? { compacted: false, shadowedSeqs: [] },
      pluginMcpResults,
      pluginAgentResults,
      ...(rewindStore !== undefined && rewindRecorder !== undefined
        ? { rewind: { store: rewindStore, recorder: rewindRecorder } }
        : {}),
      dispose,
    }
  } catch (err) {
    // A failed mount must not leak a half-built assembly.
    await dispose().catch(() => {})
    throw err
  }

  async function dispose(): Promise<void> {
    // M42 G1: stop scheduling finalizers, then wait for queued journal writes.
    rewindSubscription?.()
    rewindSubscription = undefined
    await rewindDrain
    // Unmount in REVERSE mount order (last-mounted unmounts first), best-effort:
    // one handle's failure must not block the rest — and dispose never throws.
    const mounts = [...mcpHandles, ...lspHandles, ...teamHandles]
    for (const handle of mounts.reverse()) {
      try {
        await handle.unmount()
      } catch {
        // cleanup failure on unmount: disposal continues
      }
    }
    for (const handle of [skillsMount, workflowMount]) {
      try {
        await handle?.unmount()
      } catch {
        // cleanup failure on unmount: disposal continues
      }
    }
    // M26-B2: terminal handle disposal (all PTYs).
    try {
      terminalMount.dispose()
    } catch {
      // cleanup failure on dispose: disposal continues
    }
    // M16w: the sandbox-local wrapper dropped the win32 backend's dispose() —
    // the compose site owns teardown (revocable ACL temp grants).
    try {
      winSandbox?.dispose()
    } catch {
      // cleanup failure on teardown: disposal continues
    }
    // NOTE: the coordinator and the telemetry stream are NEVER closed here —
    // the owner (run.ts / createSessionService) owns their lifecycle.
  }
}
