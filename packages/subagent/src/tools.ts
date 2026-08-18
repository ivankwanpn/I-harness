import { randomUUID } from "node:crypto"
import type { PluginContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderRegistry } from "@i-harness/provider"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { ExecService } from "@i-harness/exec"
import type { AgentRegistry } from "@i-harness/core-agent"
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
  exec: ExecService
  // M9: live Agent instances retained for the child's session id, enabling
  // followup re-drives (Task 3) without re-creating the agent.
  agents: AgentRegistry
  // M8: when present, spawned children get durable child-<uuid> sessions with
  // the parent-session lineage header (P1).
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
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
        fork_turns: { type: ["string", "number"], description: "none, all, or N." },
      },
      required: ["message", "task_name"],
    },
    isReadOnly: false,
    execute: async (args) => {
      const role = deps.roles.get(args.agent_type ?? "general")
      if (!role) throw new Error(`unknown role: ${args.agent_type}`)
      const turns = parseForkTurns(args.fork_turns)
      const { path, jobId } = await spawnChild({
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
        agents: deps.agents,
        forkTurns: turns,
        childSessions: deps.childSessions,
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

  const sendTool: Tool<{ target: string; message: string }, { queued: boolean }> = {
    name: "send_message",
    description: "Send a message to an existing subagent. Queued; does not trigger a new turn.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      // Durable inbox: append a model-hidden event through the child's mirror.
      append(entry.session, { type: "subagent/inbox", messageId: randomUUID(), message: args.message })
      entry.mailbox.push(args.message)
      return { queued: true }
    },
  }

  const interruptTool: Tool<{ target: string }, { previous_status: string }> = {
    name: "interrupt_agent",
    description: "Interrupt a subagent's current turn, if any, and return its previous status. The agent remains available.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      const previous = entry.status
      entry.controller.abort()
      return { previous_status: previous }
    },
  }

  const followupTool: Tool<{ target: string; message: string }, { delivered: boolean }> = {
    name: "followup_task",
    description: "Send a follow-up task to a subagent and trigger a new turn. This sub-project queues the message and marks delivered; re-driving the loop is deferred.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      // Durable inbox: same append as send_message; re-driving the turn is deferred to M9.
      append(entry.session, { type: "subagent/inbox", messageId: randomUUID(), message: args.message })
      entry.mailbox.push(args.message)
      return { delivered: true }
    },
  }

  const closeTool: Tool<{ target: string }, { previous_status: string }> = {
    name: "close_agent",
    description: "Close a subagent and reclaim its resources (abort execution, unmount child scope, remove from the agent and job tables).",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      const previous = entry.status
      entry.controller.abort()
      entry.unmount?.()
      if (entry.jobId) deps.jobs.kill(entry.jobId)
      deps.table.remove(args.target)
      return { previous_status: previous }
    },
  }

  const resumeTool: Tool<{ target: string }, { resumed: boolean }> = {
    name: "resume_agent",
    description: "Re-activate a previously closed subagent path with a fresh controller and session.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const existing = deps.table.get(args.target)
      if (existing && existing.status === "running") throw new Error(`subagent already running: ${args.target}`)
      deps.table.add(args.target, {
        path: args.target,
        status: "running",
        session: createSession(),
        controller: new AbortController(),
        mailbox: [],
      })
      return { resumed: true }
    },
  }

  const jobOutputTool: Tool<{ job_id: string; wait?: boolean; timeout_ms?: number }, { text: string; status: string }> = {
    name: "job_output",
    description: "Read a background job (subagent or shell). Non-blocking unless wait: true. Every response ends with [status: ...].",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, wait: { type: "boolean" }, timeout_ms: { type: "number" } }, required: ["job_id"] },
    isReadOnly: true,
    execute: async (args) => {
      // Prefer the subagent JobRegistry; fall back to the exec service (bash/pwsh jobs).
      try {
        if (args.wait === true) await deps.jobs.wait(args.job_id, args.timeout_ms ?? 30_000)
        const snapshot = deps.jobs.read(args.job_id)
        const body = snapshot.output.length > 0 ? snapshot.output : "(no output)"
        return { text: `${body}\n[status: ${snapshot.status}]`, status: snapshot.status }
      } catch (e) {
        if (!(e instanceof Error) || !/unknown job/i.test(e.message)) throw e
      }
      if (args.wait === true) {
        const deadline = Date.now() + (args.timeout_ms ?? 30_000)
        while (Date.now() < deadline && deps.exec.getOutput(args.job_id).status === "running") {
          await new Promise((r) => setTimeout(r, 20))
        }
      }
      const view = deps.exec.getOutput(args.job_id)
      const body = view.stdout.length > 0 ? view.stdout : "(no output)"
      return { text: `${body}\n[status: ${view.status}]`, status: view.status }
    },
  }

  const jobListTool: Tool<Record<string, never>, { jobs: { id: string; kind: string; status: string; label: string }[] }> = {
    name: "job_list",
    description: "List your background jobs (subagent and shell) with ids, kinds, and statuses.",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    execute: async () => {
      const sub = deps.jobs.list("root").map((j) => ({ id: j.id, kind: j.kind, status: j.status, label: j.label }))
      const shell = deps.exec.listJobs().map((v) => ({ id: v.id, kind: "bash", status: v.status, label: v.id }))
      return { jobs: [...sub, ...shell] }
    },
  }

  const jobKillTool: Tool<{ job_id: string; reason?: string }, { outcome: string }> = {
    name: "job_kill",
    description: "Request cancellation of a running background job (subagent or shell).",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, reason: { type: "string" } }, required: ["job_id"] },
    isReadOnly: false,
    execute: async (args) => {
      try {
        return { outcome: deps.jobs.kill(args.job_id) }
      } catch (e) {
        if (!(e instanceof Error) || !/unknown job/i.test(e.message)) throw e
        return { outcome: deps.exec.killJob(args.job_id) }
      }
    },
  }

  return [spawnTool, waitTool, listTool, sendTool, interruptTool, followupTool, closeTool, resumeTool, jobOutputTool, jobListTool, jobKillTool]
}

function parseForkTurns(value: string | number | undefined): "none" | "all" | number {
  if (value === undefined || value === "all") return "all"
  if (value === "none") return "none"
  const n = typeof value === "number" ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : "all"
}
