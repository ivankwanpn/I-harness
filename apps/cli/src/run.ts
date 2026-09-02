import { createSession, deriveMessages, type Session } from "@i-harness/core-session"
import { createSessionExecutor, type SessionExecutor } from "@i-harness/core-agent"
import type { CompactionConfig } from "@i-harness/compaction"
import type { MockStep } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { ShellRetentionOptions } from "@i-harness/shell"
import type { RetryConfig } from "@i-harness/guard-retry"
import type { SandboxMode } from "@i-harness/sandbox"
import type { SessionQuery } from "@i-harness/session-query"
import type { ParentInputAdmission, SubagentStateSnapshot } from "@i-harness/subagent"
import type { McpServerConfig } from "@i-harness/mcp-client"
import type { LspServerConfig } from "@i-harness/lsp"
import type { TeamConfig } from "@i-harness/agent-team"
import { registerCommand } from "@i-harness/interaction"
import { enterPlanMode } from "@i-harness/plan-mode"
import { maybeAutoTitle } from "@i-harness/session-title"
import { createTelemetry, createJsonlSink, type Telemetry } from "@i-harness/telemetry"
import { createSessionAssembly, type ReasoningEffort } from "@i-harness/session-executor"

export interface HeadlessOptions {
  workspace: string
  mockScript?: MockStep[]
  model?: ModelClient
  approveAll?: boolean
  shellTimeoutMs?: number // default 120_000; the shipped harness deadline
  shellRetention?: ShellRetentionOptions // M12: cap bash/pwsh output (default 64_000 headTail)
  retry?: RetryConfig // M12: opt-in tool retry-on-timeout (re-runs timed-out tools)
  maxParallelToolCalls?: number // M13: bound on concurrent tool bodies per step (default 10)
  sessionId?: string // new session: persist under this id
  resumeSessionId?: string // resume: load this id, restore history, continue appending
  session?: Session // M14: host-provided pre-seeded session (the harness is headless; a host can seed a session with image-bearing user/message events before the run)
  coordinator?: SessionCoordinator
  // M10b: host-provided query surface; when present the session_search +
  // lineage tools are mounted. M29: the CLI itself auto-wires a file-backed
  // query when the store root is known (--session-dir) — a host-provided one
  // always wins (no override).
  sessionQuery?: SessionQuery
  compact?: CompactionConfig // M11: enable context-pressure auto-compaction
  sandbox?: SandboxMode // M16: "read-only" | "workspace-write" | "danger-full-access"; default (unset) = no sandbox
  mcp?: McpServerConfig[] // M17: MCP servers to mount for the run (stdio or streamable-http)
  lsp?: LspServerConfig[] // M18: LSP servers to mount for the run (stdio)
  team?: Partial<TeamConfig> // M19: mount the agent-team domain (10 team tools replace the colliding subagent surface)
  telemetry?: "jsonl" // M25: enable the independent host event stream as JSONL on stdout (default off)
  planMode?: boolean // R-A7: start in plan mode (proposal = the task text; exit_plan_mode tool mounted; prompt fragment appended)
  guardian?: { policy?: string; timeoutMs?: number; model?: ModelClient } // R-A9: auto-approval guardian reviewer
  outputSpill?: import("@i-harness/output-retention").OutputSpillGuardConfig // M26-B7: registry-level output spill（設了就掛）
  // M26-D2: R-A1 輸入接納（inject tier）——host 可注入自訂 ParentInputAdmission；
  // 缺省時 run.ts 以本 run 的執行器 lane 自動建置（subagent 完成通知 → parent
  // session 的 inject 輸入 + event-driven wake）。
  parentNotify?: ParentInputAdmission
  /** M32 T3: reasoning-effort host option — forwarded verbatim to every
   * request of this run (the adapter owns the wire translation; unsupported
   * values fail loud at the model end). Absent → the request never carries the
   * field (the provider's own default applies). */
  reasoningEffort?: ReasoningEffort
}

export interface HeadlessResult {
  finalText: string
  exitCode: number
  error?: string
  session?: Session // NEW: session events so tests can assert guard outcomes
}

// Shape guard for the restored subagent-state document: a wrong-shape-but-valid
// JSON document must degrade to fresh registries instead of throwing inside
// restoreState (which the outer catch would turn into exitCode 1).
function isSubagentStateSnapshot(doc: unknown): doc is SubagentStateSnapshot {
  if (typeof doc !== "object" || doc === null) return false
  const d = doc as Record<string, unknown>
  return (
    d.formatVersion === 1 &&
    Array.isArray(d.jobs) &&
    Array.isArray(d.agentTable) &&
    Array.isArray(d.roles)
  )
}

// Headless single-agent run for the CLI. R-C0 (engine-owned): the run-level
// environment assembly (ctx/tools/shell+sandbox/fs/approval/guards/terminal/
// web/ask-user-input/tool-search/fs-search/session-query/subagent/workflow/
// mcp/lsp/teams mounts + agent) lives in @i-harness/session-executor —
// createSessionAssembly. run.ts owns ONE-TURN orchestration only: the per-
// session serial lane (A's executor), the session/* command surface, resume/
// restore/title/flush/close, and the result vocabulary. The assembly's
// dispose() owns every mount teardown + the win32 ACL sandbox — never the
// coordinator lifecycle (this file's close() does) and never the telemetry
// stream (this file closes it last on every exit path).
export async function runHeadless(task: string, opts: HeadlessOptions): Promise<HeadlessResult> {
  const activeId = opts.resumeSessionId ?? opts.sessionId
  // M25 (spec §2.2): the independent host event stream, assembled ONLY when the
  // host asks for it (`--telemetry` → opts.telemetry === "jsonl"). JSONL sink
  // on stdout; absent → no telemetry object, no events, zero behavior change.
  const telemetry: Telemetry | undefined = opts.telemetry === "jsonl" ? createTelemetry([createJsonlSink(process.stdout)]) : undefined
  if (telemetry) {
    telemetry.emit({
      type: "session/start",
      ts: Date.now(),
      data: { task, ...(activeId ? { sessionId: activeId } : {}) },
    })
  }
  // session/end marks the run's end at every exit path (success, error,
  // resume-load failure); close() flushes sinks (v0 no-op) after the run.
  const emitSessionEnd = (exitCode: number): void => {
    telemetry?.emit({ type: "session/end", ts: Date.now(), data: { ...(activeId ? { sessionId: activeId } : {}), exitCode } })
  }
  const session = opts.session ?? createSession((ev) => {
    if (!opts.coordinator || !activeId) return
    opts.coordinator.enqueue(activeId, [ev])
    if (ev.type === "turn/end") void opts.coordinator.flush(activeId).catch(() => {})
  })

  // Resume: restore the persisted history into the session WITHOUT re-appending
  // it (it is already durable); subsequent appends continue from this history.
  // A missing/corrupt session id must surface as a clean result (exitCode 1 +
  // message), not an unhandled rejection before the try/catch below.
  if (opts.resumeSessionId && opts.coordinator) {
    try {
      const { session: restored } = await opts.coordinator.load(opts.resumeSessionId)
      session.events.push(...restored.events)
      session.formatVersion = restored.formatVersion
      // M24a (G7): restore the lineage header too — it is the authoritative
      // carrier of delegationDepth/origin/parentSession (the subagent
      // max_depth guard reads header.delegationDepth), and without it a
      // resumed session would always present as root-depth.
      session.header = restored.header
      // M23: after a successful load the resumed CLI IS this session's active
      // writer (it keeps appending below), so it adopts the ownership lease
      // long-term — held until the run's coordinator.close(). Conflict (another
      // live writer still owns the session) or an unsupported platform fails
      // closed here and surfaces through the same clean exitCode-1 shape as a
      // failed load. When the coordinator's lock is disabled (tests/hosts that
      // create their own), adoptOwnership is a no-op.
      await opts.coordinator.adoptOwnership(opts.resumeSessionId)
    } catch (err) {
      emitSessionEnd(1)
      telemetry?.close()
      return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // M6: restore subagent state (jobs/agent-table/roles) from the coordinator
  // document API on resume; settled only, running→error handled by restoreState.
  // A missing/corrupt document just means no restored state — the run proceeds
  // with fresh registries (builtin seeding).
  let restoredState: SubagentStateSnapshot | undefined
  if (opts.resumeSessionId && opts.coordinator && activeId) {
    try {
      // M6: the subagent-state document is keyed by the session id (spec:
      // "stateId derived from the session id") so sessions never share state.
      const doc = await opts.coordinator.getDocument(activeId)
      if (doc && isSubagentStateSnapshot(doc)) restoredState = doc
    } catch {
      restoredState = undefined
    }
  }

  let assembly: Awaited<ReturnType<typeof createSessionAssembly>> | undefined
  // M26-D2: the run's serial lane is created below (after the assembly) — the
  // default parent-notify adapter closes over it and is rebound before the run
  // starts; a task completing before the lane exists keeps its outbox row
  // pending (fail-closed, drained by the ready-chain / recovery path).
  let executorRef: SessionExecutor | undefined
  const parentNotify: ParentInputAdmission = opts.parentNotify ?? {
    admit: async ({ text, description }) => {
      const lane = executorRef
      if (!lane) throw new Error("no session lane for parent admission")
      lane.submit({ tier: "inject", text, description, scope: "turn" })
    },
    // A executors are event-driven: admission while idle starts the idle drain,
    // so submit() IS the wake (documented in D's plan).
    wake: () => {},
  }
  try {
    assembly = await createSessionAssembly({
      workspace: opts.workspace,
      ...(activeId !== undefined ? { sessionId: activeId } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.mockScript !== undefined ? { mockScript: opts.mockScript } : {}),
      approveAll: opts.approveAll,
      ...(opts.shellTimeoutMs !== undefined ? { shellTimeoutMs: opts.shellTimeoutMs } : {}),
      ...(opts.shellRetention !== undefined ? { shellRetention: opts.shellRetention } : {}),
      ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
      ...(opts.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: opts.maxParallelToolCalls } : {}),
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      session,
      // M16 final-review (C1) parity: the policy resolves against the
      // HOST-SEEDED session only — a resumed session's fully restored history
      // must not silently override the requested mode (see AssemblyOptions.
      // policySession).
      policySession: opts.session,
      ...(opts.mcp !== undefined ? { mcp: opts.mcp } : {}),
      ...(opts.lsp !== undefined ? { lsp: opts.lsp } : {}),
      ...(opts.team !== undefined ? { team: opts.team } : {}),
      ...(opts.compact !== undefined ? { compact: opts.compact } : {}),
      ...(opts.sessionQuery !== undefined ? { sessionQuery: opts.sessionQuery } : {}),
      ...(opts.coordinator !== undefined ? { coordinator: opts.coordinator } : {}),
      ...(restoredState !== undefined ? { restoredState } : {}),
      ...(telemetry !== undefined ? { telemetry } : {}),
      ...(opts.planMode ? { planMode: true } : {}),
      ...(opts.guardian !== undefined ? { guardian: opts.guardian } : {}),
      ...(opts.outputSpill !== undefined ? { outputSpill: opts.outputSpill } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
      parentNotify,
    })
  } catch (err) {
    emitSessionEnd(1)
    telemetry?.close()
    if (opts.coordinator) await opts.coordinator.close().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  }
  if (telemetry) {
    telemetry.emit({ type: "session/request", ts: Date.now(), data: { ...(activeId ? { sessionId: activeId } : {}) } })
  }
  try {
    // R-A7: the plan-mode proposal event must be on the log before the run
    // starts (the tool mount + prompt fragment are the assembly's do).
    if (opts.planMode) enterPlanMode(session, task)
    // R-A1/R-A2: the session's serial lane. The initial task flows through the
    // executor (idle drain → one turn); host commands can submit additional
    // tiers during the run — they are promoted FIFO and drained serially. The
    // lane's inbox comes from the assembly (agent step-boundary steer claims
    // read the same inbox).
    const executor: SessionExecutor = (executorRef = createSessionExecutor({
      session,
      agent: assembly.agent,
      inbox: assembly.inbox,
    }))
    registerCommand(assembly.ctx, {
      name: "session-send",
      execute: async (input) => {
        const { text } = JSON.parse(input) as { text: string }
        executor.submit({ tier: "send", text })
        return JSON.stringify({ queued: true })
      },
    })
    registerCommand(assembly.ctx, {
      name: "session-followup",
      execute: async (input) => {
        const { text } = JSON.parse(input) as { text: string }
        executor.submit({ tier: "followup", text })
        return JSON.stringify({ queued: true })
      },
    })
    registerCommand(assembly.ctx, {
      name: "session-steer",
      execute: async (input) => {
        const { text } = JSON.parse(input) as { text: string }
        executor.submit({ tier: "steer", text })
        return JSON.stringify({ queued: true })
      },
    })
    registerCommand(assembly.ctx, {
      name: "session-inject",
      execute: async (input) => {
        const { text, description, scope } = JSON.parse(input) as { text: string; description: string; scope: "turn" | "session" }
        executor.submit({ tier: "inject", text, description, scope })
        return JSON.stringify({ queued: true })
      },
    })
    registerCommand(assembly.ctx, {
      name: "session-cancel",
      execute: async (input) => {
        const { inputId } = JSON.parse(input) as { inputId: string }
        return JSON.stringify(executor.cancel(inputId))
      },
    })
    registerCommand(assembly.ctx, {
      name: "session-pending",
      execute: async () => JSON.stringify(executor.pending().map((p) => ({ inputId: p.inputId, text: p.text, delivery: p.delivery }))),
    })
    // Initial task through the executor (serial lane; a resumed session's
    // recovered pending inputs precede it FIFO). drain REJECTS on the first
    // turn failure — thrown into the catch below → exitCode 1 (the CLI's
    // exit-code contract).
    executor.submit({ tier: "followup", text: task })
    await executor.drain()
    const derived = deriveMessages(session).at(-1)
    const finalText = typeof derived?.content === "string" ? derived.content : ""
    if (opts.coordinator) {
      // flush first: this is the durability-failure signal (rejects on a durable
      // write failure → exitCode 1); close() then drains everything best-effort.
      if (activeId) await opts.coordinator.flush(activeId)
    }
    // R-A6: first-prompt auto title after a successful run (fail-soft — LLM
    // failure degrades to the deterministic fallback; a coordinator document
    // mirror only when a session id is known).
    await maybeAutoTitle({
      session, model: assembly.model,
      ...(opts.coordinator && activeId ? { coordinator: opts.coordinator, sessionId: activeId } : {}),
    })
    if (opts.coordinator) await opts.coordinator.close()
    emitSessionEnd(0)
    telemetry?.close()
    return { finalText, exitCode: 0, session }
  } catch (err) {
    emitSessionEnd(1)
    telemetry?.close()
    if (opts.coordinator) await opts.coordinator.close().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  } finally {
    // The assembly owns every mount's reverse-order unmount + the win32 ACL
    // sandbox teardown (dispose never throws) — never the coordinator.
    await assembly?.dispose().catch(() => {})
  }
}
