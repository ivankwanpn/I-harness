import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
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
  const session = createSession()
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

  try {
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "You are a coding agent." })
    const result = await agent.run(task)
    return { finalText: result.finalText, exitCode: 0 }
  } catch (err) {
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  }
}
