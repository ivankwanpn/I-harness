import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession, type Session } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"
import type { CompactionConfig } from "@i-harness/compaction"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import { registerShell } from "@i-harness/shell"
import { createFsTools } from "@i-harness/fs"
import { createApprovalPolicy } from "@i-harness/guard-approval"
import { createRetryGuard, type RetryConfig } from "@i-harness/guard-retry"
import { createTimeoutGuard } from "@i-harness/guard-timeout"
import { createRepeatToolGuard } from "@i-harness/guard-repeat-tool"
import type { ShellRetentionOptions } from "@i-harness/shell"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { registerToolSearch } from "@i-harness/tool-search"
import { createFsSearchTools } from "@i-harness/fs-search"
import { createSessionQueryTools, type SessionQuery } from "@i-harness/session-query"
import { registerSubagent, type SubagentStateSnapshot } from "@i-harness/subagent"
import { createProviderRegistry } from "@i-harness/provider"
import { createLocalSandbox } from "@i-harness/sandbox-local"
import { createSandboxPolicy, renderPolicyContext } from "@i-harness/sandbox-policy"
import type { SandboxMode } from "@i-harness/sandbox"

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
  sessionQuery?: SessionQuery // M10b: host-provided query surface; when present the session_search + lineage tools are mounted
  compact?: CompactionConfig // M11: enable context-pressure auto-compaction
  sandbox?: SandboxMode // M16: "read-only" | "workspace-write" | "danger-full-access"; default (unset) = no sandbox
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

// Headless single-agent run for the CLI. Everything lives on ONE scope/ctx:
// the execution environment (exec + shell + fs tools) and the approval policy
// are mounted on the same ctx that the agent's tool registry dispatches
// through, so the policy IS in the dispatching scope for this path. Cross-scope
// dispatch (a child scope's registry) is gated separately by core-tools'
// `execute` consulting `ctx.resolveDecision` — see mechanism B in the Task 10
// report.
export async function runHeadless(task: string, opts: HeadlessOptions): Promise<HeadlessResult> {
  const ctx: PluginContext = createContext()
  const tools = createToolRegistry(ctx)

  // mount the execution environment + policy
  const shellTimeoutMs = opts.shellTimeoutMs ?? 120_000
  // M12: the shipped harness caps shell output at 64_000 bytes headTail unless
  // the host overrides it (parallel to the shellTimeoutMs default). A host
  // that wants no cap passes { maxBytes: Number.MAX_SAFE_INTEGER }.
  // M16: a confined mode composes the platform-local sandbox provider (bwrap
  // on Linux, ACL fabric on win32) and hands it to exec through registerShell;
  // unset or danger-full-access compose NO provider (exec stays passthrough).
  const sandboxProvider =
    opts.sandbox === undefined || opts.sandbox === "danger-full-access" ? undefined : createLocalSandbox()
  registerShell(ctx, tools, {
    timeoutMs: shellTimeoutMs,
    retention: opts.shellRetention ?? { maxBytes: 64_000 },
    ...(sandboxProvider !== undefined ? { sandbox: sandboxProvider } : {}),
  })
  for (const tool of createFsTools({ workspace: opts.workspace })) tools.register(tool)
  createApprovalPolicy(ctx, tools, { workspace: opts.workspace })

  // M10a guards (part of the shipped harness):
  //  - timeout: cooperative deadline on tools that declare timeoutMs (bash/pwsh).
  //  - repeat-reminder: advisory consecutive-repeat notice for the model.
  // M12 retry (OPT-IN — re-runs timed-out tools, changing execution semantics):
  // `ctx.cascade` runs handlers in registration order, FIRST REGISTERED =
  // OUTERMOST, so createRetryGuard MUST be mounted BEFORE createTimeoutGuard
  // to observe the timeout wrapper's substituted TOOL_TIMEOUT raw value (retry
  // outer, timeout inner).
  if (opts.retry) ctx.mount(createRetryGuard(ctx, opts.retry))
  ctx.mount(createTimeoutGuard(ctx))
  ctx.mount(createRepeatToolGuard(ctx))

  // approval: approveAll → auto-approve; else fail closed (no answerer)
  if (opts.approveAll) {
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
  }

  registerToolSearch(ctx, tools)

  // fs-search glob/grep (replaces the deferred grep stub below)
  const execService = ctx.services.get<import("@i-harness/exec").ExecService>("exec/service")
  for (const tool of createFsSearchTools({ exec: execService })) tools.register(tool)

  // M10b: session-query tools (sqlite-only, read-only). No sessionQuery → not
  // mounted (capability-gated, behavior unchanged).
  if (opts.sessionQuery) {
    for (const tool of createSessionQueryTools(opts.sessionQuery)) tools.register(tool)
  }

  const model = opts.model ?? createMockClient(opts.mockScript ?? [{ role: "assistant", text: "ok" }])

  // M7: session events go through the coordinator's write-behind (batched,
  // durable on flush). One durability point per turn; the 200 ms deadline
  // coalesces intra-turn events. Without a coordinator the events stay in the
  // in-memory session only.
  // M14: when the host passes a pre-seeded `session`, use it as-is — the
  // onAppend coordinator hook lives ONLY on this internal createSession, so a
  // host-provided session carries no write-behind (the host owns durability;
  // a coordinator passed alongside is still used for the flush-on-turn/end and
  // resume/load paths below).
  const activeId = opts.resumeSessionId ?? opts.sessionId
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
    } catch (err) {
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

  try {
    // Mount the subagent + job tools so the main agent can delegate.
    // M8: persist child sessions through the same coordinator (child lineage
    // records the main session id) and on resume load each restored child's
    // durable log into a live mirror session.
    const subagent = registerSubagent(ctx, tools, {
      providers: createProviderRegistry(),
      exec: ctx.services.get<import("@i-harness/exec").ExecService>("exec/service"),
      parentModel: model,
      parentSession: session,
      // M7: the coordinator owns document-write serialization, failure
      // reporting (reportBackgroundFailure), and run-end draining.
      ...(opts.coordinator && activeId
        ? { persist: { coordinator: opts.coordinator, stateId: activeId, parentSessionId: activeId } }
        : {}),
      ...(restoredState ? { restoredState } : {}),
    })
    if (opts.coordinator && opts.resumeSessionId && activeId) {
      for (const entry of subagent.table.entries().values()) {
        if (!entry.sessionId) continue
        try {
          const loaded = await opts.coordinator.load(entry.sessionId)
          // Fresh mirror session (like the main session resume): history loaded,
          // subsequent appends keep persisting through the write-behind.
          const resumed = createSession((ev) => {
            opts.coordinator!.enqueue(entry.sessionId!, [ev])
            if (ev.type === "turn/end") void opts.coordinator!.flush(entry.sessionId!).catch(() => {})
          })
          resumed.events.push(...loaded.session.events)
          resumed.formatVersion = loaded.session.formatVersion
          resumed.header = loaded.session.header
          entry.session = resumed
        } catch {
          // missing/corrupt child log → keep the empty stub
        }
      }
    }
    // M16: when a sandbox mode is configured, the policy owner resolves the
    // effective policy (deployment default; mode requested may be overridden
    // by a sandbox/mode session event) and its rendered context is injected
    // into the system prompt so the agent knows the standing file policy.
    // Unset → no policy, prompt unchanged.
    const sandboxPolicy =
      opts.sandbox === undefined ? undefined : createSandboxPolicy({ mode: opts.sandbox, workspaceRoot: opts.workspace })
    let systemPrompt = "You are a coding agent."
    if (sandboxPolicy) {
      systemPrompt = `${systemPrompt}\n\n${renderPolicyContext(sandboxPolicy.resolve())}`
    }
    const agent = createAgent(ctx, {
      session, tools, model,
      systemPrompt,
      ...(opts.compact ? { compact: opts.compact } : {}),
      ...(opts.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: opts.maxParallelToolCalls } : {}),
    })
    const result = await agent.run(task)
    if (opts.coordinator) {
      // flush first: this is the durability-failure signal (rejects on a durable
      // write failure → exitCode 1); close() then drains everything best-effort.
      if (activeId) await opts.coordinator.flush(activeId)
      await opts.coordinator.close()
    }
    return { finalText: result.finalText, exitCode: 0, session }
  } catch (err) {
    if (opts.coordinator) await opts.coordinator.close().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  }
}
