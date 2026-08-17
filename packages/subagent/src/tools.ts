import type { PluginContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderRegistry } from "@i-harness/provider"
import type { JobRegistry } from "./jobs.ts"
import type { AgentTable } from "./agent-table.ts"
import type { RoleRegistry } from "./roles.ts"
import { spawnChild } from "./child.ts"

export interface SubagentToolDeps {
  table: AgentTable
  jobs: JobRegistry
  roles: RoleRegistry
  parentRegistry: ToolRegistry
  parentSession: ReturnType<typeof createSession>
  parentCtx: PluginContext
  parentModel: ModelClient
  providers: ProviderRegistry
}

export function createSubagentTools(deps: SubagentToolDeps): Tool[] {
  const spawnTool: Tool<{ message: string; task_name: string; agent_type?: string; fork_turns?: string | number }, { agent_path: string; job_id: string }> = {
    name: "spawn_agent",
    description: "Launch a subagent in the background. Returns an agent path and job id immediately. Use wait_agent or job_output to observe completion.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Initial task for the subagent." },
        task_name: { type: "string", description: "Short name used in the agent path." },
        agent_type: { type: "string", description: "Role name (default general)." },
        fork_turns: { type: "string", description: "none, all, or N." },
      },
      required: ["message", "task_name"],
    },
    isReadOnly: false,
    execute: async (args) => {
      const role = deps.roles.get(args.agent_type ?? "general")
      if (!role) throw new Error(`unknown role: ${args.agent_type}`)
      const turns = parseForkTurns(args.fork_turns)
      const { path, jobId } = spawnChild({
        taskName: args.task_name,
        message: args.message,
        parentPath: "root",
        parentRegistry: deps.parentRegistry,
        parentSession: deps.parentSession,
        parentCtx: deps.parentCtx,
        role,
        parentModel: deps.parentModel,
        providers: deps.providers,
        jobs: deps.jobs,
        table: deps.table,
        forkTurns: turns,
      })
      return { agent_path: path, job_id: jobId }
    },
  }

  const waitTool: Tool<{ timeout_ms?: number }, { message: string; timed_out: boolean }> = {
    name: "wait_agent",
    description: "Wait for any live subagent to reach a terminal status. Returns a brief summary and whether it timed out.",
    inputSchema: { type: "object", properties: { timeout_ms: { type: "number", description: "Max wait in ms (default 30000)." } } },
    isReadOnly: true,
    execute: async (args) => {
      const timeoutMs = args.timeout_ms ?? 30_000
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const running = [...deps.table.entries().values()].some((e) => e.status === "running")
        if (!running) {
          const done = [...deps.table.entries().values()].map((e) => e.path)
          return { message: `All subagents settled: ${done.join(", ") || "(none)"}`, timed_out: false }
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      return { message: "wait timed out with subagents still running", timed_out: true }
    },
  }

  const listTool: Tool<{ path_prefix?: string }, { agents: { path: string; status: string }[] }> = {
    name: "list_agents",
    description: "List live subagents in the current tree, optionally filtered by path prefix.",
    inputSchema: { type: "object", properties: { path_prefix: { type: "string" } } },
    isReadOnly: true,
    execute: async (args) => {
      const prefix = args.path_prefix ?? ""
      const agents = [...deps.table.entries().values()]
        .filter((e) => e.path.startsWith(prefix))
        .map((e) => ({ path: e.path, status: e.status }))
      return { agents }
    },
  }

  return [spawnTool, waitTool, listTool]
}

function parseForkTurns(value: string | number | undefined): "none" | "all" | number {
  if (value === undefined || value === "all") return "all"
  if (value === "none") return "none"
  const n = typeof value === "number" ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : "all"
}
