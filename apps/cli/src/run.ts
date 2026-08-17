import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionEvent } from "@i-harness/core-session"
import { registerShell } from "@i-harness/shell"
import { createFsTools } from "@i-harness/fs"
import { createApprovalPolicy } from "@i-harness/guard-approval"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { registerToolSearch } from "@i-harness/tool-search"
import { createFsSearchTools } from "@i-harness/fs-search"
import { registerSubagent, type SubagentStateSnapshot } from "@i-harness/subagent"
import { createProviderRegistry } from "@i-harness/provider"

export interface HeadlessOptions {
  workspace: string
  mockScript?: MockStep[]
  model?: ModelClient
  approveAll?: boolean
  sessionId?: string // new session: persist under this id
  resumeSessionId?: string // resume: load this id, restore history, continue appending
  coordinator?: SessionCoordinator
}

export interface HeadlessResult {
  finalText: string
  exitCode: number
  error?: string
}

// M6: serialize document writes through the coordinator. Subagent persistence
// saves are fire-and-forget (`void save(...)` in the wrapped registries), so
// two saves can race two putDocument calls against the same sidecar file and
// interleave/truncate each other at the OS level (observed as concatenated
// JSON). Chaining keeps exactly one document write in flight at a time; a
// failed write does not wedge the chain. Session append/flush go through the
// raw coordinator and are unaffected.
function withSerializedDocuments(coordinator: SessionCoordinator): SessionCoordinator {
  let chain: Promise<void> = Promise.resolve()
  return {
    ...coordinator,
    putDocument(key, data) {
      chain = chain.catch(() => {}).then(() => coordinator.putDocument(key, data))
      return chain
    },
  }
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
  registerShell(ctx, tools)
  for (const tool of createFsTools({ workspace: opts.workspace })) tools.register(tool)
  createApprovalPolicy(ctx, tools, { workspace: opts.workspace })

  // approval: approveAll → auto-approve; else fail closed (no answerer)
  if (opts.approveAll) {
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
  }

  registerToolSearch(ctx, tools)

  // fs-search glob/grep (replaces the deferred grep stub below)
  const execService = ctx.services.get<import("@i-harness/exec").ExecService>("exec/service")
  for (const tool of createFsSearchTools({ exec: execService })) tools.register(tool)

  const model = opts.model ?? createMockClient(opts.mockScript ?? [{ role: "assistant", text: "ok" }])

  // Persistence mirror: buffer appended events and flush each batch to the
  // coordinator at turn/end (a natural durability boundary), plus a final flush.
  let pendingEvents: SessionEvent[] = []
  const activeId = opts.resumeSessionId ?? opts.sessionId
  const flushPending = async () => {
    if (!opts.coordinator || !activeId) return
    if (pendingEvents.length === 0) return
    const batch = pendingEvents
    pendingEvents = []
    await opts.coordinator.append(activeId, batch)
  }
  const session = createSession((ev) => {
    pendingEvents.push(ev)
    if (ev.type === "turn/end") void flushPending()
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
  if (opts.resumeSessionId && opts.coordinator) {
    try {
      const doc = await opts.coordinator.getDocument("subagent-state")
      if (doc) restoredState = doc as SubagentStateSnapshot
    } catch {
      restoredState = undefined
    }
  }

  try {
    // Mount the subagent + job tools so the main agent can delegate.
    registerSubagent(ctx, tools, {
      providers: createProviderRegistry(),
      exec: ctx.services.get<import("@i-harness/exec").ExecService>("exec/service"),
      parentModel: model,
      parentSession: session,
      // M6: persist every subagent registry mutation through the coordinator
      // document API (fixed key shared across sessions in the same backend).
      // putDocument is serialized so fire-and-forget saves never race each
      // other against the same sidecar file.
      ...(opts.coordinator && (opts.sessionId || opts.resumeSessionId)
        ? { persist: { coordinator: withSerializedDocuments(opts.coordinator), stateId: "subagent-state" } }
        : {}),
      ...(restoredState ? { restoredState } : {}),
    })
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "You are a coding agent." })
    const result = await agent.run(task)
    await flushPending()
    if (opts.coordinator && activeId) await opts.coordinator.flush(activeId)
    return { finalText: result.finalText, exitCode: 0 }
  } catch (err) {
    await flushPending().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  }
}
