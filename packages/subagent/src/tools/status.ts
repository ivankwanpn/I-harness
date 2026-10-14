import type { Tool } from "@i-harness/core-tools"
import type { SubagentToolDeps } from "./types.ts"
import { userSteerForTool, waitForObservation } from "@i-harness/core-tools"
import { runningElapsedMs } from "../agent-table.ts"

export function createListTool(deps: SubagentToolDeps): Tool {
  const listTool: Tool<{ path_prefix?: string; scope?: "children" | "descendants" }, { agents: { path: string; status: string; elapsed_ms?: number; roleName?: string; jobId?: string; sessionId?: string; finalText?: string; error?: string }[] }> = {
    name: "list_agents",
    description: "List live subagents in the current tree with their role/job/session details. A RUNNING agent's row also carries elapsed_ms — how long its current run has been going (a re-driven child's clock restarts with the new run) — so a long-running child is distinguishable from one that just started. scope 'children' lists only direct children of the prefix (default base 'root'), 'descendants' the whole subtree; without scope, path_prefix keeps the legacy startsWith filter.",
    inputSchema: { type: "object", properties: { path_prefix: { type: "string" }, scope: { type: "string", enum: ["children", "descendants"], description: "children = direct children only; descendants = the whole subtree below the prefix." } } },
    isReadOnly: true,
    execute: async (args) => {
      const prefix = args.path_prefix ?? ""
      const agents = [...deps.table.entries().values()]
        .filter((e) => {
          // M24a (B5): scope filters the tree by depth. Paths look like
          // root/a/b — descendants of a base are everything under base/,
          // children only the next segment.
          if (args.scope === "descendants") {
            const base = args.path_prefix ?? "root"
            return e.path.startsWith(base + "/")
          }
          if (args.scope === "children") {
            const base = args.path_prefix ?? "root"
            if (!e.path.startsWith(base + "/")) return false
            return !e.path.slice(base.length + 1).includes("/")
          }
          return e.path.startsWith(prefix) // legacy behavior (backward compat)
        })
        .map((e) => {
          // W11: the asked path. `elapsed_ms` is present for a RUNNING child
          // only — a settled one has no run in flight, and a stale duration
          // would read as if it did. Absent, never 0: `runningElapsedMs`
          // returns undefined for both "not running" and "no stamp", and the
          // section (the unasked path) is where a running-but-unstamped entry
          // is called out rather than silently dropped.
          const elapsed = runningElapsedMs(e)
          return {
            path: e.path,
            status: e.status,
            ...(elapsed !== undefined ? { elapsed_ms: elapsed } : {}),
            ...(e.roleName !== undefined ? { roleName: e.roleName } : {}),
            ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
            ...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {}),
            ...(e.finalText !== undefined ? { finalText: e.finalText } : {}),
            ...(e.error !== undefined ? { error: e.error } : {}),
          }
        })
      return { agents }
    },
  }
  return listTool
}

export function createJobOutputTool(deps: SubagentToolDeps): Tool {
  const jobOutputTool: Tool<{ job_id: string; wait?: boolean; timeout_ms?: number }, { text: string; status: string; yielded?: true; yield_reason?: "user-steer" }> = {
    name: "job_output",
    description: "Read a background job (subagent, shell, or workflow). Non-blocking unless wait: true; new user input can yield the wait while the same job continues. Every response ends with [status: ...].",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, wait: { type: "boolean" }, timeout_ms: { type: "number" } }, required: ["job_id"] },
    isReadOnly: true,
    execute: async (args, exec) => {
      // Resolve and authorize the backend before installing any observation.
      let read: () => { status: string; output: string }
      let subscribe: (wake: (view: { status: string }) => void) => () => void
      if (deps.workflow && args.job_id.startsWith("workflow-")) {
        const workflow = deps.workflow
        read = () => { const v = workflow.getOutput(args.job_id); return { status: v.status, output: v.stdout } }
        subscribe = wake => workflow.subscribeJob(args.job_id, wake)
      } else {
        let subagent = true
        try { deps.jobs.read(args.job_id) } catch (error) {
          if (!(error instanceof Error) || !/unknown job/i.test(error.message)) throw error
          subagent = false
        }
        read = subagent ? () => deps.jobs.read(args.job_id) : () => { const v = deps.exec.getOutput(args.job_id); return { status: v.status, output: v.stdout } }
        subscribe = subagent ? wake => deps.jobs.subscribe(args.job_id, wake) : wake => deps.exec.subscribeJob(args.job_id, wake)
      }
      let terminalSeen = read().status !== "running"
      const reason = args.wait === true ? await waitForObservation({
        ready: () => terminalSeen || read().status !== "running",
        changes: { subscribe: wake => subscribe(view => { terminalSeen ||= view.status !== "running"; wake() }) },
        timeoutMs: args.timeout_ms === Infinity || Number.isNaN(args.timeout_ms) ? undefined : Math.max(0, args.timeout_ms ?? 30_000),
        abortSignal: exec.abortSignal, userSteer: userSteerForTool(exec),
      }) : undefined
      exec.abortSignal?.throwIfAborted()
      const view = read()
      return { text: `${view.output || "(no output)"}\n[status: ${view.status}]`, status: view.status,
        ...(reason === "user-steer" && view.status === "running" ? { yielded: true as const, yield_reason: "user-steer" as const } : {}) }
    },
  }
  return jobOutputTool
}

export function createJobListTool(deps: SubagentToolDeps): Tool {
  const jobListTool: Tool<Record<string, never>, { jobs: { id: string; kind: string; status: string; label: string; agent_path?: string; session_id?: string }[] }> = {
    name: "job_list",
    description: "List your background jobs (subagent, shell, and workflow) with ids, kinds, and statuses.",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: true,
    execute: async () => {
      const sub = deps.jobs.list("root").map((j) => {
        const entry = [...deps.table.entries().values()].find(row => row.jobId === j.id)
        const agentPath = j.agentPath ?? entry?.path
        const sessionId = j.sessionId ?? entry?.sessionId
        return { id: j.id, kind: j.kind, status: j.status, label: j.label,
          ...(agentPath !== undefined ? { agent_path: agentPath } : {}), ...(sessionId !== undefined ? { session_id: sessionId } : {}) }
      })
      const shell = deps.exec.listJobs().map((v) => ({ id: v.id, kind: "bash", status: v.status, label: v.id }))
      // M24b (spec §3.3): workflow jobs join the index as kind "workflow".
      const workflow = deps.workflow
        ? deps.workflow.listJobs().map((v) => ({ id: v.id, kind: "workflow", status: v.status, label: v.id }))
        : []
      return { jobs: [...sub, ...shell, ...workflow] }
    },
  }
  return jobListTool
}
