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

  // register a deferred grep-style tool so tool_search has something to find
  tools.register({
    name: "grep",
    description: "search text in files",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
    exposure: "deferred",
    searchHint: "find patterns",
    isReadOnly: true,
    execute: async () => ({ matches: [] }),
  })
  registerToolSearch(ctx, tools)

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

  try {
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
