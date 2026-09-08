// packages/session-executor/src/assembly.ts — R-C0 (engine-owned posture).
// ONE assembly implementation. `runHeadless` (one-shot) and the web
// `createSessionService` (multi-turn) both build through this. The branch's
// per-session live-agent file no longer exists (its full environment was the
// old run.ts; the CURRENT run.ts environment — terminal/web/ask_user_input/
// output-spill/plan-mode/guardian/instructions/runtime-context/mcp-oauth —
// is the source of truth and sinks here verbatim).
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession, Inbox, subscribe, type Session } from "@i-harness/core-session"
import { RewindError, RewindRecorder, RewindStore } from "@i-harness/rewind"
import { createToolRegistry, registerContextRemaining } from "@i-harness/core-tools"
import { createAgent, type Agent, type ReasoningEffort } from "@i-harness/core-agent"
import { approxTokens, type CompactionConfig, type CompactionResult } from "@i-harness/compaction"
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
// BUG-1 (m49 audit): node:sqlite's ExperimentalWarning is suppressed by the
// session-query package itself (a module side effect that evaluates before
// its node:sqlite import) — the assembly needs no explicit wiring.
import { createSessionQueryTools, type SessionQuery } from "@i-harness/session-query"
import { registerSubagent, projectWorkflowRows, type AgentTaskView, type ParentInputAdmission, type SubagentStateSnapshot } from "@i-harness/subagent"
import { registerSkills } from "@i-harness/skills"
import { registerWorkflow, type WorkflowMountHandle } from "@i-harness/workflow"
import {
  mountMcpClient,
  type McpMountHandle,
  type McpServerConfig,
  type McpServerStatusEvent,
  type McpTokenStore,
} from "@i-harness/mcp-client"
import type { Telemetry } from "@i-harness/telemetry"
import { mountLspClient, type LspMountHandle, type LspServerConfig } from "@i-harness/lsp"
import {
  mountAgentTeams,
  type TeamDeps,
  type TeamMountHandle,
  type TeamConfig,
} from "@i-harness/agent-team"
import { createProviderRegistry } from "@i-harness/provider"
import { createLocalSandbox } from "@i-harness/sandbox-local"
import { createSandboxPolicy, renderPolicyContext } from "@i-harness/sandbox-policy"
import type { SandboxMode, SandboxProvider } from "@i-harness/sandbox"
import { DEFAULT_AGENT_PRESET, parsePreset } from "@i-harness/preset"

export type ModelPolicy = "required" | "test-mock"

export class ModelUnavailableError extends Error {
  constructor(message = "No model configured") {
    super(message)
    this.name = "ModelUnavailableError"
  }
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
  shellRetention?: ShellRetentionOptions // M12: cap bash/pwsh output
  retry?: RetryConfig // M12: opt-in tool retry-on-timeout
  maxParallelToolCalls?: number // M13: bound on concurrent tool bodies per step
  mcp?: McpServerConfig[] // M17: MCP servers to mount
  pluginMcp?: McpServerConfig[] // per-server containment; pluginMcpResults reports
  lsp?: LspServerConfig[] // M18: LSP servers to mount
  skills?: { extraDirs?: string[] } // plugin overlay skill roots
  team?: Partial<TeamConfig> // M19: mount the agent-team domain
  sessionQuery?: SessionQuery // M10b: session_search + lineage tools
  compact?: CompactionConfig // M11
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
  /** The session the sandbox policy resolution READS for sandbox/mode events —
   * the HOST-SEEDED session only (run.ts parity: a resumed a session's fully
   * restored history must not silently override the requested mode; the CLI
   * passes opts.session here). Absent → resolve against nothing (branch
   * live-agent parity). */
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
}

/** M42 G1: the rewind slice of an assembly — the host (run.ts / the web
 * service) builds a RewindService over these for the rewind surface. */
export interface RewindAssemblyHandle {
  store: RewindStore
  recorder: RewindRecorder
}

export interface SessionAssembly {
  ctx: PluginContext // host wires approval/question answerers here (via onAssembly)
  agent: Agent // the per-session agent; tier-1 turns flow through it
  session: Session // the live session — the source of truth
  sessionId?: string
  model: ModelClient // the resolved client (owner uses it for e.g. auto-title)
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
export function estimateAssemblyOverhead(systemPrompt: string, schemas: unknown): number {
  return approxTokens(systemPrompt) + approxTokens(JSON.stringify(schemas))
}

export async function createSessionAssembly(opts: AssemblyOptions): Promise<SessionAssembly> {
  // Resolve before mounting resources so a required-but-missing model cannot
  // leave a partially initialized assembly behind.
  const model: ModelClient = opts.model ?? (() => {
    if (opts.modelPolicy !== "test-mock") throw new ModelUnavailableError()
    return opts.mockScript === undefined && opts.mockCycles === true
      ? cyclicMockClient([{ role: "assistant", text: "ok" }])
      : createMockClient(opts.mockScript ?? [{ role: "assistant", text: "ok" }])
  })()
  const ctx: PluginContext = createContext()
  const tools = createToolRegistry(ctx)

  // ── execution environment + policy ─────────────────────────────────────────
  // Same sequence as runHeadless: terminal first (registerTerminal may be
  // reclaimed via the handle in dispose), then shell+plaintext, web, fs.
  const terminalMount: TerminalMountHandle = registerTerminal(ctx, tools)
  const shellTimeoutMs = opts.shellTimeoutMs ?? 120_000
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
  // M16 final-review (C1): resolve the effective policy ONCE and pass the SAME
  // resolved value to the enforce step and the prompt renderer — the prompt
  // and the enforcement can never drift. A host-seeded session event actually
  // applies; an empty internal session resolves to the requested mode.
  const sandboxPolicy =
    opts.sandbox === undefined
      ? undefined
      : createSandboxPolicy({ mode: opts.sandbox, workspaceRoot: opts.workspace }).resolve({
          session: opts.policySession,
        })
  registerShell(ctx, tools, {
    timeoutMs: shellTimeoutMs,
    retention: opts.shellRetention ?? { maxBytes: 64_000 },
    ...(sandboxProvider !== undefined ? { sandbox: sandboxProvider } : {}),
    ...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
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
  const fsToolsDeps = rewindRecorder !== undefined
    ? { workspace: opts.workspace, rewind: { take: (path: string, before: Uint8Array | null) => rewindRecorder.take(path, before) } }
    : { workspace: opts.workspace }
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
  for (const tool of createFsSearchTools({ exec: execService })) tools.register(tool)
  if (opts.sessionQuery) {
    for (const tool of createSessionQueryTools(opts.sessionQuery)) tools.register(tool)
  }

  // ── session: live source of truth + coordinator mirror (write-behind) ──────
  const session = opts.session ?? createSession((ev) => {
    if (opts.coordinator === undefined || opts.sessionId === undefined) return
    opts.coordinator.enqueue(opts.sessionId, [ev])
    if (ev.type === "turn/end") void opts.coordinator.flush(opts.sessionId).catch(() => {})
  })
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

  // R-A4/R-A5: dynamic system context — sections render at every step boundary
  // via the agent/pre-step hook. Instructions load as one section.
  installRuntimeContext(ctx, session).registerSection(
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
  const prepareMcpConfig = (cfg: McpServerConfig): McpServerConfig =>
    cfg.transport === "streamable-http" && cfg.auth !== undefined && cfg.auth.store === undefined && opts.coordinator
      ? { ...cfg, auth: { ...cfg.auth, store: coordinatorTokenStore(opts.coordinator) } }
      : cfg
  const mcpStatusHook = (ev: McpServerStatusEvent): void => {
    opts.telemetry?.emit({ type: "mcp/server-status", ts: Date.now(), data: { ...(ev as unknown as Record<string, unknown>) } })
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
    for (const cfg of opts.lsp ?? []) {
      lspHandles.push(await mountLspClient(ctx, tools, { ...cfg, cwd: cfg.cwd ?? opts.workspace }))
    }
    workflowMount = registerWorkflow(ctx, tools, { workspace: opts.workspace, exec: execService })
    const providers = createProviderRegistry()
    const subagent = registerSubagent(ctx, tools, {
      providers,
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
        providers,
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
          providers: createProviderRegistry(),
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
    let systemPrompt = opts.preset !== undefined
      ? parsePreset(opts.preset).systemPrompt
      : DEFAULT_AGENT_PRESET.systemPrompt
    if (opts.planMode) systemPrompt = `${systemPrompt}\n\n${PLAN_MODE_SYSTEM_PROMPT}`
    if (sandboxPolicy) {
      systemPrompt = `${systemPrompt}\n\n${renderPolicyContext(sandboxPolicy)}`
    }

    // M33 §3.2: when the window is resolved and the host did not supply an
    // overhead, the assembly supplies the estimate into BOTH count surfaces
    // (M11 compact config — host's explicit overheadTokens always wins — and
    // the M20 budget ladder).
    const overheadEstimate = opts.contextWindow === undefined
      ? undefined
      : estimateAssemblyOverhead(systemPrompt, tools.schemas())

    const agent = createAgent(ctx, {
      session, tools, model,
      systemPrompt,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      // M31 T3: when the assembly's window resolved, it feeds BOTH the M11
      // compaction engine (catalog-first config window ← the unified value,
      // "有值才供") and the M20 budget ladder. Without a resolved window the
      // compact pass-through stays exactly as the caller wrote it (CLI path).
      ...(opts.compact !== undefined
        ? {
            compact: opts.contextWindow !== undefined
              ? {
                  ...opts.compact,
                  contextWindow: opts.contextWindow,
                  ...(opts.compact.overheadTokens === undefined && overheadEstimate !== undefined ? { overheadTokens: overheadEstimate } : {}),
                }
              : opts.compact,
          }
        : {}),
      // M31 T3: AgentBudgetConfig.contextWindow is required — supply only when
      // a window was resolved (absent → no budget → pre-M20 behavior).
      ...(opts.contextWindow !== undefined && overheadEstimate !== undefined
        ? { budget: { contextWindow: opts.contextWindow, overheadTokens: overheadEstimate } }
        : {}),
      ...(opts.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: opts.maxParallelToolCalls } : {}),
      ...(opts.telemetry !== undefined ? { telemetry: opts.telemetry } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
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
