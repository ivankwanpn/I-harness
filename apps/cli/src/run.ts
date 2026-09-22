import { append, createSession, deriveMessages, type Session } from "@i-harness/core-session"
import { createSessionExecutor, type SessionExecutor } from "@i-harness/core-agent"
import type { CompactionRequest, CompactionResult } from "@i-harness/compaction"
import type { MockStep } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator, SessionModelSelection } from "@i-harness/session-persistence"
import type { ShellRetentionOptions } from "@i-harness/shell"
import type { RetryConfig } from "@i-harness/guard-retry"
import type { SandboxMode } from "@i-harness/sandbox"
import type { SessionQuery } from "@i-harness/session-query"
import type { ParentInputAdmission, SubagentStateSnapshot } from "@i-harness/subagent"
import type { McpServerConfig } from "@i-harness/mcp-client"
import type { LspServerConfig } from "@i-harness/lsp"
import type { TeamConfig } from "@i-harness/agent-team"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { createPromptCommand, registerCommand, registerPromptCommand } from "@i-harness/interaction"
import { resolveHarnessHome } from "@i-harness/harness-home"
import { createHookRegistry, createHookTrustStore, resolveHookTrustPath, type HookRegistry } from "@i-harness/hooks"
import { PluginRegistry, toMcpServerConfigs, toSubagentRoles } from "@i-harness/plugin-registry"
import { enterPlanMode } from "@i-harness/plan-mode"
import { maybeAutoTitle } from "@i-harness/session-title"
import { createMetricsSink, createTelemetry, createJsonlSink, type Telemetry } from "@i-harness/telemetry"
import {
  createSessionAssembly,
  type AssemblyOptions,
  type ModelPolicy,
  type ReasoningEffort,
} from "@i-harness/session-executor"
import type { ProviderRuntime, SessionModelBinding } from "@i-harness/provider-runtime"
import { loadProviderRuntime, roleModelResolverFor } from "./provider-runtime.ts"
import { registerCliSecrets } from "./diagnostics-bootstrap.ts"
import { diagnosticsFor, fromError, type DiagnosticPhase, type Redactor } from "@i-harness/diagnostics"

// W6 T5: one module-scope handle, and the phase is the SEAM rather than the
// file: all five migrated sites here are the plugin/hook/mcp mount's own
// warnings (the `[plugins]`/`[hooks]` tags in their messages), so they report
// as `mount`. The one site that is NOT the mount — the `[metrics]` report at
// the end of a run — is one of the plan's named exceptions and stays a
// plain console call.
const d = diagnosticsFor("mount")

// M33 §5: the session-compact command handler — pure (testable) surface.
// v0 error semantics: busy text while the executor lane is running (the
// manual compact is only supposed to run on the idle lane), the
// "No compactable history yet." text when nothing was compacted, and a JSON
// echo { compacted, shadowedSeqs, summary? } otherwise. `instructions` are
// forwarded to the summarizer ("User instructions" section).
/**
 * The command names this file registers on the assembly's context, in ONE place.
 *
 * Two readers depend on it and they must not drift: the registrations below, and
 * the plugin runtime above, which hands the list to `PluginRegistry` as
 * `existingCommandNames` so a plugin command cannot claim one of them. Kept a
 * literal because the live catalog does not exist until the assembly returns,
 * and the conflict is resolved at plugin-enable time, not at read time.
 */
const CLI_COMMAND_NAMES = [
  "session-send",
  "session-followup",
  "session-steer",
  "session-inject",
  "session-cancel",
  "session-pending",
  "session-compact",
] as const

/**
 * The tools a PLUGIN's subagent role may use, as a host permit list.
 *
 * This is the ONLY source of a tool name in a plugin role: the plugin's own
 * `tools:` list (written in Claude Code's vocabulary) can narrow it and can
 * never widen it. `toSubagentRoles` enforces that structurally, so a plugin
 * cannot reach a tool by any path that is not on this list.
 *
 * READ-ONLY, and deliberately so. The CLI is a development/test harness, not the
 * product: a plugin agent that needs to write should get that from a host whose
 * policy says it may, and no host has made that call yet. Widening this is a
 * policy decision, not a bug fix — which is why it is one named constant whose
 * change is visible in a diff.
 */
const PLUGIN_AGENT_TOOLS = ["read", "glob", "grep", "list_dir"] as const

export interface SessionCompactCommandDeps {
  compactNow(instructions?: string): Promise<CompactionResult>
  isRunning(): boolean
}

export async function handleSessionCompactCommand(
  deps: SessionCompactCommandDeps,
  input: string,
): Promise<string> {
  if (deps.isRunning()) {
    return "session-compact is busy: the agent is still running — wait for the current turn to finish before compacting."
  }
  const parsed = JSON.parse(input) as { instructions?: unknown }
  const instructions = parsed.instructions
  if (instructions !== undefined && typeof instructions !== "string") {
    throw new TypeError("session-compact: instructions must be a string")
  }
  const result = await deps.compactNow(instructions)
  if (!result.compacted) return "No compactable history yet."
  return JSON.stringify({
    compacted: result.compacted,
    shadowedSeqs: result.shadowedSeqs,
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
  })
}

export interface HeadlessOptions {
  workspace: string
  mockScript?: MockStep[]
  model?: ModelClient
  /**
   * M3: abort the run from the host side. A real SIGINT/SIGTERM does the same
   * thing — this exists so the unwind is reachable without a process boundary,
   * and so a host that outlives one run can cancel it.
   *
   * The abort is HONOURED AT TURN GRANULARITY, not mid-tool: `SessionExecutor`
   * checks `signal.aborted` at the pump head and the agent at its own step
   * boundaries, so an in-flight tool call finishes and the events already
   * appended stay appended. What the signal buys is the UNWIND — `finally` runs,
   * the assembly disposes, and `coordinator.close()` drains the write-behind's
   * pending batch. Without it the process is killed where it stands.
   */
  signal?: AbortSignal
  /** Production defaults to required. `test-mock` is reserved for explicit
   * test fixtures; supplying mockScript is itself an explicit mock fixture. */
  modelPolicy?: ModelPolicy
  /** The session's INITIAL model selection for THIS run, when the caller has
   * one — provider:model plus, for `i-harness run --protocol P`, the wire the
   * run speaks. It rides the resolution below and is written to NO file (§4.3:
   * a session's protocol is not persisted). A protocol named here is the most
   * specific rung of the chain (selection > model row > route), so it wins over
   * both the route's declaration and a resumed session's durable selection —
   * which keeps its own provider:model, because that is the session's. Absent ⇒
   * the chain resolves exactly as it did before this option existed. A caller
   * naming a protocol has to name provider:model with it: there is no rung to
   * attach a wire to otherwise, and inventing one is what §4.3 forbids. */
  sessionSelection?: SessionModelSelection
  /** Injectable runtime for hermetic composition tests. Absent uses the
   * canonical settings/credentials paths. */
  providerRuntime?: ProviderRuntime
  approveAll?: boolean
  shellTimeoutMs?: number // default 120_000; the shipped harness deadline
  /** W10: foreground bash/pwsh promotion threshold — a command still running
   * after this many ms is handed back as a job id and keeps running, instead of
   * dying at `shellTimeoutMs`. Default 30_000; MUST stay well under
   * `shellTimeoutMs` (at or above it the deadline wins and this never fires).
   * See AssemblyOptions.shellBackgroundAfterMs. */
  shellBackgroundAfterMs?: number
  /** W11: how long a sub-agent may run before the main agent is told about it
   * — the `subagents` runtime-context section names the children past this
   * threshold at the next step boundary, and `list_agents` reports each one's
   * `elapsed_ms`. Default 600_000 (10 min); it starts no turn (idle self-wake
   * is a settled NO), so an idle session stays idle however long a child runs.
   * See AssemblyOptions.subagentStaleAfterMs for the relationship between this
   * number and the parent's own blocking waits. */
  subagentStaleAfterMs?: number
  shellRetention?: ShellRetentionOptions // M12: cap bash/pwsh output (default 64_000 headTail)
  retry?: RetryConfig // M12: opt-in tool retry-on-timeout (re-runs timed-out tools)
  maxParallelToolCalls?: number // M13: bound on concurrent tool bodies per step (default 10)
  sessionId?: string // new session: persist under this id
  resumeSessionId?: string // resume: load this id, restore history, continue appending
  /** M3 §3.4: the HOST's identity — the diagnostics instance's runId, put on
   *  the durable run-end record so the live JSONL (which stamps the same id on
   *  every line) and the session log can be joined after the fact. Absent ⇒ the
   *  record mints its own, which is what an embedder with no diagnostics
   *  instance gets. */
  runId?: string
  /** The redactor the record's `error` is DERIVED through. ABSENT ⇒ no `error`
   *  field at all, deliberately not an un-redacted one: the four llm adapters
   *  throw the provider's response body, which is where a credential comes back
   *  in (`fromError`'s contract). A host with no redactor records the exit
   *  without a reason rather than a reason it cannot trust. */
  redactor?: Redactor
  session?: Session // M14: host-provided pre-seeded session (the harness is headless; a host can seed a session with image-bearing user/message events before the run)
  coordinator?: SessionCoordinator
  // M10b: host-provided query surface; when present the session_search +
  // lineage tools are mounted. M29: the CLI itself auto-wires a file-backed
  // query when the store root is known (--session-dir) — a host-provided one
  // always wins (no override).
  sessionQuery?: SessionQuery
  // M11: enable context-pressure auto-compaction. The WINDOW is not part of this
  // contract — `runHeadless` resolves the model binding itself and the assembly
  // fills the window in. It used to require `contextWindow` here, which the CLI
  // could not supply, so nothing ever set it and layer 1 of the budget ladder was
  // dead on every shipped path.
  compact?: CompactionRequest
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
  /** The host's declared role models (settings' `agents.roles.<name>`), read at
   * SPAWN time through this getter — see `AssemblyOptions.roleSelectionFor`.
   * The CLI supplies it from the loaded settings store; absent (the embedder
   * default) → no role has a declared model. */
  roleSelectionFor?: AssemblyOptions["roleSelectionFor"]
  /** `plugins.subagentModel`, the switch that lets a role run on its own
   * declared model. ABSENT MEANS OFF — see
   * `AssemblyOptions.allowSubagentModelSelection`. */
  allowSubagentModelSelection?: boolean
}

export interface HeadlessResult {
  finalText: string
  exitCode: number
  error?: string
  session?: Session // NEW: session events so tests can assert guard outcomes
  /** The session this run worked on, so a caller can NAME it when reporting a
   * failure (M3's diagnose-ability). Absent when the caller supplied no id and
   * none was generated. */
  sessionId?: string
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
/**
 * M3 fail-loud / diagnosability: what a run that ends badly TELLS the operator.
 *
 * ONE report for the two ways it happens, because they are the same question —
 * "which run, and what survived?" — and they were answered differently and badly:
 *
 *   - a run that returned `{exitCode: 1, error}` printed `console.error(r.error)`:
 *     ONE bare line, no session, no context (`apps/cli/src/index.ts`);
 *   - an UNHANDLED error got Node's own reporter: a stack trace that names no run
 *     at all.
 *
 * M3's completion definition is that a failed run can be located "不需要人手讀
 * JSONL" — which is exactly the `session` and `durable` lines.
 *
 * The `durable` line is the LOSS CONTRACT, written here because this is the moment
 * somebody needs it: `session-persistence`'s write-behind batches on a 200 ms
 * deadline, flushes on `turn/end`, and is drained by `coordinator.close()` — so
 * everything already flushed survives and the tail of the in-flight turn may not.
 * Measured (write-behind.ts + the runner's onAppend), never assumed.
 *
 * Pure and total: a rejection can carry anything, so this takes `unknown` and
 * never throws.
 */
export function failureReport(err: unknown, ctx: { sessionId?: string; kind: "crashed" | "failed" }): string {
  const message = err instanceof Error ? err.message : String(err)
  const frame = err instanceof Error ? err.stack?.split("\n")[1]?.trim() : undefined
  const headline = ctx.kind === "crashed" ? "i-harness crashed" : "i-harness run did not finish"
  return [
    "",
    `── ${headline} ${"─".repeat(Math.max(4, 62 - headline.length))}`,
    `  session  : ${ctx.sessionId ?? "(no session — this happened before one existed)"}`,
    `  error    : ${message}`,
    ...(frame !== undefined ? [`  at       : ${frame}`] : []),
    "",
    "  durable  : every event already flushed is on disk. The write-behind",
    "             batches on a 200 ms deadline and flushes at turn end, so the",
    "             TAIL of a turn that was still running may not be — that is the",
    "             one part of this run to re-check before resuming it.",
    "────────────────────────────────────────────────────────────────",
  ].join("\n")
}

/**
 * The session the CURRENT run is working on, for the process-level crash
 * reporter in `index.ts`.
 *
 * A module-level slot, deliberately: the crash handler lives at the process entry
 * because THAT is where exiting is correct — a library function must not call
 * `process.exit`. The slot carries the one thing the entry cannot know and the
 * reader most needs. **Diagnostic only; nothing reads it to make a decision.**
 */
let crashSession: string | undefined
export function diagnosticSessionId(): string | undefined { return crashSession }

export async function runHeadless(task: string, opts: HeadlessOptions): Promise<HeadlessResult> {
  const activeId = opts.resumeSessionId ?? opts.sessionId
  // M25 (spec §2.2): the independent host event stream, assembled ONLY when the
  // host asks for it (`--telemetry` → opts.telemetry === "jsonl"). JSONL sink
  // on stdout; absent → no telemetry object, no events, zero behavior change.
  // M3: the metrics sink is attached ALWAYS (it is a counter map; the cost is
  // nothing) but only REPORTED when the operator asked for observability. That
  // is also what keeps `createMetricsSink` off the reachability instrument's
  // orphan list — an accumulator with no reader is exactly the shape this repo
  // keeps deleting, and wiring a reader is the fix, not an allowlist entry.
  const metrics = createMetricsSink()
  const telemetry: Telemetry | undefined = opts.telemetry === "jsonl"
    ? createTelemetry([createJsonlSink(process.stdout), metrics])
    : createTelemetry([metrics])
  // M3 §3.4: the clock the durable record's `durationMs` is measured from — read
  // UNCONDITIONALLY, not beside the emit below, because a run with telemetry off
  // still owes its record a duration.
  const runStartedAt = Date.now()
  // The record's identity, minted ONCE per run. `randomUUID` is a fallback, not
  // a second source of truth — the CLI always passes the instance's own runId —
  // but minting it per append would stamp the double-record case's two records
  // with two different ids, leaving one run un-joinable to itself. No shipped
  // path reaches the fallback either way; this is what keeps it safe if one does.
  const runId = opts.runId ?? randomUUID()
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

  // M3 §3.4: the durable run-end record. Written while the coordinator is still
  // open — the success path closes it before `emitSessionEnd` fires, which is
  // why this is NOT part of `emitSessionEnd` (that funnel runs after the close,
  // and a coordinator closed under it takes no further events).
  //
  // Appended through `append`, so it rides the same mirror as every other event
  // (the coordinator enqueue in the callback above) and the record's `seq` is
  // assigned like any other's; its identity is the single `runId` minted above.
  const appendRunEnd = (exitCode: number, phase: DiagnosticPhase, err?: unknown): void => {
    if (!opts.coordinator || activeId === undefined) return
    const error = err !== undefined && opts.redactor !== undefined ? fromError(err, opts.redactor).message : undefined
    append(session, {
      type: "operator/run-end", version: 1,
      runId,
      exitCode, durationMs: Date.now() - runStartedAt, phase,
      ...(error !== undefined ? { error } : {}),
    })
  }

  // Resume: restore the persisted history into the session WITHOUT re-appending
  // it (it is already durable); subsequent appends continue from this history.
  // A missing/corrupt session id must surface as a clean result (exitCode 1 +
  // message), not an unhandled rejection before the try/catch below.
  if (opts.resumeSessionId && opts.coordinator) {
    try {
      const { session: restored } = await opts.coordinator.loadOwned(opts.resumeSessionId)
      session.events.push(...restored.events)
      session.formatVersion = restored.formatVersion
      // M24a (G7): restore the lineage header too — it is the authoritative
      // carrier of delegationDepth/origin/parentSession (the subagent
      // max_depth guard reads header.delegationDepth), and without it a
      // resumed session would always present as root-depth.
      session.header = restored.header
      // loadOwned acquired the long-term writer lease before reading and made
      // any crash-tail recovery canonical before this live mirror continues.
    } catch (err) {
      emitSessionEnd(1)
      telemetry?.close()
      return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err), ...(activeId !== undefined ? { sessionId: activeId } : {}) }
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
  crashSession = activeId
  // M3: the abort path. `sdk` and `acp` already had one (`teardown()` wired to
  // SIGINT/SIGTERM); `run` did not, so an interrupt mid-turn skipped the
  // `finally` entirely — no dispose, no `coordinator.close()`, and therefore no
  // drain of the write-behind's pending batch. The signal is composed with a
  // host-supplied one rather than replacing it: `AbortSignal.any` fires on
  // whichever aborts first, and neither caller has to know about the other.
  const abort = new AbortController()
  const onSignal = (): void => { abort.abort() }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  const runSignal = opts.signal !== undefined ? AbortSignal.any([opts.signal, abort.signal]) : abort.signal
  // One registry per hook SOURCE (the harness home's own config, plus each
  // enabled plugin's): `createHookRegistry` takes one config and owns its load,
  // so N sources are N mounts. All of them must see session/start and session/end.
  const hookRegistries: HookRegistry[] = []
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
    const modelPolicy = opts.modelPolicy
      ?? (opts.mockScript !== undefined ? "test-mock" : "required")
    // One runtime per run, created at most once: the session's binding and a
    // ROLE's selection resolve through the same provider plane (the resolver
    // below is providerModelBindingFor's role twin). Lazy on purpose — a run
    // handed its model and spawning no model-carrying role loads nothing.
    let runtimePromise: Promise<ProviderRuntime> | undefined
    const runtimeNow = (): Promise<ProviderRuntime> => {
      runtimePromise ??= opts.providerRuntime !== undefined
        ? Promise.resolve(opts.providerRuntime)
        : loadProviderRuntime().then((loaded) => {
            // W6 T4: the handle this line used to DROP. §3.5's declared refs
            // (`settings.llm.providers[*].apiKeyEnv`) are resolved through this
            // store and registered on the CLI's redactor — the second source of
            // the registered set, and the file half the env scan cannot see.
            //
            // It is fed HERE because this is the earliest instant that store
            // exists on this path: the load is lazy on purpose (a `--model` run
            // and a run that spawns no model-carrying role pay nothing for it),
            // so the host entry that installs the instance cannot have one yet.
            // A no-op when no CLI instance is installed — an embedder calling
            // `runHeadless` directly has no redactor to feed.
            registerCliSecrets(loaded.settings, loaded.credentials)
            return loaded.runtime
          })
      return runtimePromise
    }
    let providerBinding: SessionModelBinding | undefined
    if (opts.model === undefined && modelPolicy === "required") {
      const runtime = await runtimeNow()
      const meta = opts.coordinator !== undefined && activeId !== undefined
        ? (await opts.coordinator.profile(activeId)).meta
        : undefined
      // §4.3: the CLI's `run --protocol P` arrives as `opts.sessionSelection`
      // (the CLI composes `llm.defaultModel` + the flag — it is the only caller
      // that can read that layer). The two rungs are in hand ONLY here:
      //
      //  - a USABLE durable selection is the SESSION's own, so it keeps its
      //    provider:model (a resumed run must not silently switch model);
      //  - the caller's protocol is layered over whichever base wins, being the
      //    most specific rung (selection > model row > route).
      //
      // A caller-supplied selection is NEVER discarded (review F3): dropping one
      // because the durable half is unusable would take the caller's
      // provider:model AND its protocol with it and let the chain resolve
      // somewhere else — a silent success on a wire nobody named, this unit's
      // defect class. An empty durable pair (unreachable through the shipped
      // store, whose writers both refuse one, but this option is public) falls
      // back to the caller's own rung, and a caller that named nothing at all is
      // passed THROUGH so the chain refuses rather than falling through.
      //
      // No caller-supplied selection ⇒ what this block always did.
      let sessionSelection = meta?.modelSelection
      if (opts.sessionSelection !== undefined) {
        const supplied = opts.sessionSelection
        const durable = meta?.modelSelection
        sessionSelection = durable !== undefined && durable.provider !== "" && durable.model !== ""
          ? { ...durable, ...(supplied.protocol !== undefined ? { protocol: supplied.protocol } : {}) }
          : supplied
      }
      const state = await runtime.resolveModel({
        ...(sessionSelection !== undefined ? { sessionSelection } : {}),
      })
      if (state.status !== "ready") throw new Error(state.reason)
      providerBinding = state.binding
    }
    const contextWindow = providerBinding?.contextWindow
    // M72 Ⅱ: the same binding's resolved output cap. Handed on verbatim —
    // undefined stays undefined, because "no cap resolved" is a fact the
    // request has to keep (nothing here defaults it; core-agent clamps it).
    const maxOutputTokens = providerBinding?.maxOutputTokens
    // The window is handed to the assembly as `contextWindow` either way; it is
    // the assembly that feeds it INTO the compaction config. Merging it here as
    // well was a second copy of that logic — and the copy was wrong: when no
    // window resolved it passed `opts.compact` through unchanged, i.e. a config
    // missing the field the engine requires, instead of declining.
    // ── plugin runtime ───────────────────────────────────────────────────────
    // A machine-level registry under the harness home, read ONCE per agent build
    // like every other assembly input. Empty when nothing is installed: one state
    // read, no directory walking. Design:
    // docs/superpowers/specs/2026-09-17-plugin-mount-design.md.
    const pluginRegistry = new PluginRegistry({
      root: join(resolveHarnessHome(), "plugins"),
      // The seven names this file registers further down. A literal list rather
      // than the live catalog because the catalog does not exist until the
      // assembly below returns — and a plugin command silently shadowing
      // `session-send` would be a behaviour change nobody asked for.
      existingCommandNames: [...CLI_COMMAND_NAMES],
    })
    const pluginInputs = pluginRegistry.runtimeInputs()
    const pluginMcp = toMcpServerConfigs(pluginInputs.mcpServerConfigs)
    for (const skippedMcp of pluginMcp.skipped) {
      d.warn(`[plugins] skipping MCP server ${skippedMcp.serverName}: ${skippedMcp.reason}`)
    }
    for (const desc of pluginInputs.commandDescriptors) {
      if (desc.unsupported !== undefined) {
        // Design §3 decision 3: an unhonoured frontmatter key is reported, never
        // silently ignored — a command declaring `allowed-tools` must not appear
        // to be restricted when nothing enforces it. Durable recording onto the
        // plugin record is owed and belongs at enable() time, because
        // `runtimeInputs()` is read-only by contract ("reads never materialize").
        d.warn(`[plugins] command ${desc.name} declares unsupported frontmatter: ${desc.unsupported.join(", ")}`)
      }
    }
    // Agent roles. The plugin writes Claude Code's tool vocabulary and this repo
    // registers different names, so the conversion is the mount point where a
    // declaration either becomes a real grant or is refused — and a refusal is
    // REPORTED, because a role that quietly runs with fewer tools than it
    // declares is the failure this whole path exists to avoid.
    const pluginAgents = toSubagentRoles(pluginInputs.agentDescriptors, {
      allowedTools: [...PLUGIN_AGENT_TOOLS],
    })
    for (const missed of pluginAgents.unresolved) {
      d.warn(`[plugins] agent ${missed.role} declares an unusable tool (${missed.reason}): ${missed.tool}`)
    }

    assembly = await createSessionAssembly({
      workspace: opts.workspace,
      ...(activeId !== undefined ? { sessionId: activeId } : {}),
      modelPolicy,
      ...(opts.model !== undefined
        ? { model: opts.model }
        : providerBinding !== undefined ? { model: providerBinding.client } : {}),
      ...(providerBinding !== undefined ? { modelLabel: providerBinding.label } : {}),
      ...(opts.mockScript !== undefined ? { mockScript: opts.mockScript } : {}),
      approveAll: opts.approveAll,
      ...(opts.shellTimeoutMs !== undefined ? { shellTimeoutMs: opts.shellTimeoutMs } : {}),
      ...(opts.shellBackgroundAfterMs !== undefined ? { shellBackgroundAfterMs: opts.shellBackgroundAfterMs } : {}),
      ...(opts.subagentStaleAfterMs !== undefined ? { subagentStaleAfterMs: opts.subagentStaleAfterMs } : {}),
      ...(opts.shellRetention !== undefined ? { shellRetention: opts.shellRetention } : {}),
      ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
      ...(opts.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: opts.maxParallelToolCalls } : {}),
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      session,
      // M16 final-review (C1) parity. WHAT PROTECTS THE MODE HERE IS THE
      // ASSEMBLY'S FLOOR SLICE, not `policySession` — rewritten 2026-09-15
      // because the previous comment named a mechanism this file does not have.
      // `assembly.ts` takes `policyFloor = policyBase.events.length` at
      // construction and the resolver reads `events.slice(policyFloor)`, so
      // every event present at mount — restored history included — is excluded
      // from the mode decision.
      //
      // `policySession: opts.session` cannot be that protection: `session` above
      // is `opts.session ?? createSession(...)`, and the resumed events are
      // pushed INTO `session.events`, so this passes either the SAME object as
      // the live session or `undefined` (which the assembly falls back from to
      // that same object). It never selects a different session here.
      //
      // Why it matters: a resumed session carries a `sandbox/mode` decision made
      // in an EARLIER run — possibly an escalation to danger-full-access — and
      // letting it win would run `--resume X --sandbox read-only` unrestricted.
      // HAZARD: because `policySession` is a no-op in this file, a later reader
      // who "simplifies" the floor slice on the belief that this option is
      // protecting them reintroduces that privilege escalation on resume.
      policySession: opts.session,
      ...(opts.mcp !== undefined ? { mcp: opts.mcp } : {}),
      // Plugin runtime, from the registry read above. Both seams already
      // existed and were documented for exactly this use — `pluginMcp` mounts
      // each server and reports per-server containment into `pluginMcpResults`,
      // and `skills.extraDirs` is scanned as an overlay root. Neither had a
      // production caller until now.
      ...(pluginInputs.skillDirs.length > 0 ? { skills: { extraDirs: pluginInputs.skillDirs } } : {}),
      ...(pluginMcp.configs.length > 0 ? { pluginMcp: pluginMcp.configs } : {}),
      ...(pluginAgents.roles.length > 0 ? { pluginAgents: pluginAgents.roles } : {}),
      ...(opts.lsp !== undefined ? { lsp: opts.lsp } : {}),
      ...(opts.team !== undefined ? { team: opts.team } : {}),
      ...(opts.compact !== undefined ? { compact: opts.compact } : {}),
      ...(opts.sessionQuery !== undefined ? { sessionQuery: opts.sessionQuery } : {}),
      ...(opts.coordinator !== undefined ? { coordinator: opts.coordinator } : {}),
      ...(restoredState !== undefined ? { restoredState } : {}),
      ...(telemetry !== undefined ? { telemetry } : {}),
      ...(opts.planMode ? { planMode: true } : {}),
      ...(opts.guardian !== undefined ? { guardian: opts.guardian } : {}),
      // M5 T4 block ③: MOUNTED BY DEFAULT. Until this line, `createOutputSpillGuard`
      // had tests and no production mount — the exact "declared, tested, never
      // wired" shape this repo's reachability audit exists to find.
      //
      // NOTE WHAT IT CHANGES: IH's guard rewrites `output` — the DURABLE record,
      // not the model-facing rendering (dsh's rewrites `content`). So this is a
      // change to what the session log holds, not to how it is displayed. spec
      // §4.3 states that trade-off and why it is taken: the bound survives a
      // replay, which a rendering-only bound would not.
      outputSpill: opts.outputSpill ?? {},
      ...(opts.reasoningEffort !== undefined
        ? { reasoningEffort: opts.reasoningEffort }
        : providerBinding?.reasoningEffort !== undefined
          ? { reasoningEffort: providerBinding.reasoningEffort }
          : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      resolveRoleModel: roleModelResolverFor(runtimeNow),
      // The role-model gate, from whoever supplied the run (the CLI's main()
      // reads it from the settings store). Omitted when the caller passed
      // neither: an unset switch is OFF and a declared role model is refused,
      // never resolved on the strength of an omission.
      ...(opts.roleSelectionFor !== undefined ? { roleSelectionFor: opts.roleSelectionFor } : {}),
      ...(opts.allowSubagentModelSelection !== undefined ? { allowSubagentModelSelection: opts.allowSubagentModelSelection } : {}),
      parentNotify,
    })
    // Plugin commands are registered FIRST, so this file's own seven — registered
    // further down, outside this try — always win a name collision. The registry
    // was handed CLI_COMMAND_NAMES so it should never offer a colliding name;
    // this ordering makes the guarantee local rather than depending on that.
    for (const desc of pluginInputs.commandDescriptors) {
      registerPromptCommand(assembly.ctx, createPromptCommand(desc))
    }
    // The hooks policy layer — backend middleware, not a UI feature: its
    // `pre-tool` handler can VETO a tool call (`block:true`), and it reads
    // `<harness home>/hooks.json`.
    //
    // "Default off" needs no flag here: a host with no such file gets zero
    // handlers, so **the file's existence IS the opt-in**. (A MALFORMED file
    // still fails the run — the user asked for hooks and the request is
    // unreadable, which is the repo's fail-loud stance rather than a silent
    // "policy quietly not applied".)
    //
    // `approvals` is deliberately not passed: this mount is the user's OWN
    // config, which is self-granting under the D1 rule. A plugin's hooks arrive
    // by another path and DO need the store — see
    // docs/handoff/2026-09-18-prior-art-survey.md §4.
    hookRegistries.push(await createHookRegistry(assembly.ctx))

    // Plugin hooks — a DIFFERENT TREE's config, so under D1 every handler starts
    // UNGRANTED: skipped and reported once, neither enforced nor allowed to
    // block, until a user grants that hash. The store is the user-layer one; the
    // granting UX is the frontend's, so today nothing is granted and nothing
    // runs. That is the DESIGN, not a gap — "no grant ⇒ no run" is the rule
    // working, and the declaration is visible in the report rather than silent.
    const approvals = createHookTrustStore(resolveHookTrustPath())
    for (const hookConfig of pluginInputs.hookConfigs) {
      try {
        hookRegistries.push(await createHookRegistry(assembly.ctx, {
          configPath: hookConfig,
          configDir: dirname(hookConfig),
          approvals,
        }))
      } catch (err) {
        // A plugin's hooks must never brick the run — the SAME rule as an
        // ungranted declaration (c0b941d0), through the one door it left open. A
        // config we cannot parse contributes ZERO handlers, which is exactly
        // what an ungranted one contributes, so the run proceeds and the reason
        // is reported rather than swallowed.
        //
        // NOT a formality, and not about malformed plugins: Claude Code plugins
        // ship `hooks/hooks.json` in CC's shape (`{hooks:{<Event>:[...]}}`) and
        // that is the shape our plugin model reads. Letting the refusal
        // propagate meant ANY enabled CC plugin carrying hooks failed EVERY run
        // — measured 2026-09-19 against the real home, with `superpowers`
        // enabled, on runs that never touch a hook.
        d.warn(
          `[plugins] hooks config ${hookConfig} could not be loaded; its hooks contribute nothing for this run: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (activeId !== undefined) {
      for (const registry of hookRegistries) await registry.beginSession(activeId)
    }
  } catch (err) {
    emitSessionEnd(1)
    // Site ①: the exit taken when the run died BEFORE the assembly was built
    // (the model resolution above is the shipped trigger). `mount` — no turn
    // ever ran. The append must precede the close below: a closed coordinator
    // drains what it holds, it does not accept new events.
    appendRunEnd(1, "mount", err)
    telemetry?.close()
    if (opts.coordinator) await opts.coordinator.close().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err), ...(activeId !== undefined ? { sessionId: activeId } : {}) }
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
      // The seam already existed (`SessionExecutorDeps.signal`, checked at the
      // pump head); nothing had ever passed one.
      signal: runSignal,
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
    registerCommand(assembly.ctx, {
      name: "session-compact",
      description: "compact the session now (shadow + summary; optional instructions)",
      argumentHints: "{ instructions?: string }",
      execute: (input) => handleSessionCompactCommand(
        { compactNow: (instructions) => assembly.compactNow(instructions), isRunning: () => executor.isRunning() },
        input,
      ),
    })
    // Initial task through the executor (serial lane; a resumed session's
    // recovered pending inputs precede it FIFO). drain REJECTS on the first
    // turn failure — thrown into the catch below → exitCode 1 (the CLI's
    // exit-code contract).
    executor.submit({ tier: "followup", text: task })
    await executor.drain()
    const derived = deriveMessages(session).at(-1)
    const finalText = typeof derived?.content === "string" ? derived.content : ""
    // Site ②: the success exit. Appended BEFORE the flush — this is the one
    // path that closes the coordinator only later (`maybeAutoTitle` runs in
    // between), so this append is what makes the record's own durability the
    // same event as every other event's: it rides the flush below.
    appendRunEnd(0, "run")
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
    // The metrics summary, when the operator asked for observability. On STDERR
    // because stdout carries ONLY the telemetry's NDJSON frames (the same
    // discipline `sdk` and `acp` follow) — a summary printed to stdout would
    // corrupt the stream it is summarising.
    if (opts.telemetry === "jsonl") {
      const m = metrics.snapshot()
      const events = Object.entries(m.events).map(([k, v]) => `${k}=${v}`).join(" ")
      const tokens = Object.entries(m.tokens).map(([k, v]) => `${k}=${v}`).join(" ")
      // M5 T2: the provider's own numbers, NEVER merged with `tokens` above —
      // that section is our estimate, this one is what the wire said. Read the
      // two together with `provider/usage` in the event list: that count is the
      // denominator, and it is what makes a `0` here mean "the provider said
      // zero" instead of "nothing ever reported".
      const reported = Object.entries(m.reported).map(([k, v]) => `${k}=${v}`).join(" ")
      const tools = Object.entries(m.tools).map(([k, v]) => `${k}=${v.ok}/${v.ok + v.error}`).join(" ")
      // M5/D3: rewritten/total, sitting next to the provider's own numbers above
      // — the CAUSE on the left, the COST on the right.
      const prefix = m.prefix.requests === 0
        ? ""
        : `${m.prefix.rewritten}/${m.prefix.requests}${m.prefix.lastCause === undefined ? "" : ` (${m.prefix.lastCause})`}`
      // M5 T2 (second half): broke/observed — the MEASURED half of the prefix
      // question, beside D3's attributed half above. The denominator is
      // `observed`, NOT `requests`: the first request of a process has nothing
      // to compare against, so it is neither kept nor broke, and a run that
      // printed `0` there would be claiming a measurement it never made.
      const continuity = m.prefix.requests === 0 ? "" : `${m.prefix.broke}/${m.prefix.observed}`
      console.error(`[metrics] ${events}${tokens === "" ? "" : `  tokens: ${tokens}`}${reported === "" ? "" : `  reported: ${reported}`}${prefix === "" ? "" : `  prefix(rewritten/total): ${prefix}`}${continuity === "" ? "" : `  prefix(broke/observed): ${continuity}`}${tools === "" ? "" : `  tools(ok/total): ${tools}`}`)
    }
    emitSessionEnd(0)
    telemetry?.close()
    return { finalText, exitCode: 0, session, ...(activeId !== undefined ? { sessionId: activeId } : {}) }
  } catch (err) {
    emitSessionEnd(1)
    // Site ③: the run's own failure (a turn that threw, a durable flush that
    // rejected) — the assembly WAS built, so `run` and not `mount`. Before the
    // close below for the same reason as site ①.
    appendRunEnd(1, "run", err)
    telemetry?.close()
    if (opts.coordinator) await opts.coordinator.close().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err), ...(activeId !== undefined ? { sessionId: activeId } : {}) }
  } finally {
    // The handlers come off on EVERY exit path. A run that left them behind
    // accumulates one pair per invocation, and a host running many sessions
    // reaches Node's listener warning for reasons unrelated to its own code.
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    crashSession = undefined // no run is in flight once this one has left
    // session/end fires on EVERY exit path — success and failure alike — the
    // same way the telemetry session/end does. A hook recording session
    // teardown must not be skipped because the run errored, and it must run
    // BEFORE the assembly tears its seams down. A handler failure is reported
    // rather than rethrown: on the way out it would replace the run's real
    // outcome with the observer's.
    if (activeId !== undefined) {
      for (const registry of hookRegistries) {
        await registry.endSession(activeId).catch((err: unknown) => {
          d.warn(`[hooks] session/end handler failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }
    // The assembly owns every mount's reverse-order unmount + the win32 ACL
    // sandbox teardown (dispose never throws) — never the coordinator.
    await assembly?.dispose().catch(() => {})
  }
}
