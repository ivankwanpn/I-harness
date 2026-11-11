import type { Tool } from "@i-harness/core-tools"
import type { SubagentToolDeps } from "./types.ts"
import {childFactOwner} from '../child/document.ts'

export function createInterruptTool(deps: SubagentToolDeps): Tool {
  const interruptTool: Tool<{ target: string }, { previous_status: string }> = {
    name: "interrupt_agent",
    description: "Interrupt a subagent's current turn, if any, and return its previous status. The agent remains available.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      await childFactOwner(entry,deps.childSessions?.coordinator)
      const previous = entry.status
      entry.controller.abort()
      await entry.cancel?.("Subagent interrupted")
      return { previous_status: previous }
    },
  }
  return interruptTool
}

export function createCloseTool(deps: SubagentToolDeps): Tool {
  const closeTool: Tool<{ target: string }, { previous_status: string }> = {
    name: "close_agent",
    description: "Close a subagent by its exact returned management path. Aborts and drains execution, unmounts its scope, and removes the runtime; its job result remains available. Its outstanding task terminalizes as cancelled.",
    inputSchema: { type: "object", properties: { target: { type: "string", description: "Exact agent path from spawn_agent or list_agents." } }, required: ["target"] },
    isReadOnly: false,
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) {
        // Closing an already-terminal task is idempotent. The durable record is
        // the evidence that this management path existed; do not turn cleanup
        // into a permanent TOOL_FAILED loop after a session recovery.
        const known = deps.tasks.list().some(task => task.agentPath === args.target && task.outcome !== undefined)
        if (known) return { previous_status: "inactive" }
        throw new Error(`unknown subagent: ${args.target}`)
      }
      const previous = entry.status
      await childFactOwner(entry,deps.childSessions?.coordinator)
      deps.table.update(entry.path, entry, { closing: true })
      entry.controller.abort()
      // M26-D3: a closed chat no longer has an outstanding settlement — terminalize
      // its task record as cancelled so a cold restore never reclassifies it.
      for (const t of deps.tasks.list()) {
        if (t.agentPath === entry.path && t.outcome === undefined) {
          deps.tasks.terminalize({ taskId: t.id, outcome: "cancelled", error: "subagent closed" })
        }
      }
      if (entry.dispose) await entry.dispose()
      else entry.unmount?.()
      if (entry.jobId) deps.jobs.kill(entry.jobId)
      if (deps.table.get(args.target) === entry) deps.table.remove(args.target)
      if (entry.sessionId) deps.agents.remove(entry.sessionId)
      return { previous_status: previous }
    },
  }
  return closeTool
}

export function createJobKillTool(deps: SubagentToolDeps): Tool {
  const jobKillTool: Tool<{ job_id: string; reason?: string; backend?: "shell" | "child" | "workflow"; job_instance_id?: string; source_id?: string }, { outcome: string }> = {
    name: "job_kill",
    description: "Request cancellation of a running background job (subagent, shell, or workflow).",
    inputSchema: { type: "object", additionalProperties: false, properties: { job_id: { type: "string" }, reason: { type: "string" }, backend: { type: "string", enum: ["shell", "child", "workflow"] }, job_instance_id: { type: "string" }, source_id: { type: "string" } }, required: ["job_id"] },
    isReadOnly: false,
    execute: async (args) => {
      const keys = ['job_id', 'reason', 'backend', 'job_instance_id', 'source_id']
      if (Object.keys(args).some(key => !keys.includes(key)) || typeof args.job_id !== 'string' || !args.job_id.trim()
        || (args.backend !== undefined && !['shell', 'child', 'workflow'].includes(args.backend))
        || (args.reason !== undefined && typeof args.reason !== 'string')
        || (args.job_instance_id !== undefined && (typeof args.job_instance_id !== 'string' || !args.job_instance_id.trim()))
        || (args.source_id !== undefined && (typeof args.source_id !== 'string' || !args.source_id.trim()))) throw new Error('invalid-selector')
      if (args.backend === "shell") {
        if (!args.job_instance_id || deps.exec.supportsNativeJobKill !== true) throw new Error("Checked native cancellation unavailable")
        const selected = deps.exec.getJobView?.(args.job_id)?.nativeJob
        if (!selected || selected.version !== 1 || selected.jobId !== args.job_id || !selected.ownerSessionId || selected.instanceId !== args.job_instance_id) throw new Error('stale-instance')
        if (args.source_id !== undefined && selected.sourceId !== args.source_id) throw new Error('stale-source')
        return { outcome: await deps.exec.killJob(args.job_id, { jobInstanceId: args.job_instance_id, ...(args.source_id !== undefined ? { sourceId: args.source_id } : {}) }) }
      }
      if (args.job_instance_id !== undefined || args.source_id !== undefined) throw new Error(args.backend === undefined ? "unsupported-selector" : "Native selectors require shell backend")
      if (args.backend === "child") return { outcome: deps.jobs.kill(args.job_id) }
      if (args.backend === "workflow") {
        if (!deps.workflow) throw new Error("Workflow cancellation unavailable")
        return { outcome: deps.workflow.killJob(args.job_id) }
      }
      // M24b (spec §3.3) third layer: `workflow-` ids route to the workflow
      // job store (its killJob aborts the run's current step process tree).
      if (deps.workflow && args.job_id.startsWith("workflow-")) {
        return { outcome: deps.workflow.killJob(args.job_id) }
      }
      try {
        return { outcome: deps.jobs.kill(args.job_id) }
      } catch (e) {
        if (!(e instanceof Error) || !/unknown job/i.test(e.message)) throw e
        return { outcome: await deps.exec.killJob(args.job_id) }
      }
    },
  }
  return jobKillTool
}

export function createStopTaskTool(deps: SubagentToolDeps): Tool {
  const stopTaskTool: Tool<{ task_id: string; reason?: string }, { outcome: string; cancelled: number; task_ids: string[] }> = {
    name: "stop_task",
    description: "Cancel a subagent task and its whole descendant tree (durable cancelled markers + interrupt + quiescence wait). Already-terminal tasks report finished.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, reason: { type: "string" } }, required: ["task_id"] },
    isReadOnly: false,
    execute: async (args) => {
      const existing = deps.tasks.get(args.task_id)
      if (!existing) throw new Error(`unknown task: ${args.task_id}`)
      if (existing.outcome !== undefined) return { outcome: "already-finished", cancelled: 0, task_ids: [] }
      const result = await cancelSubtree(deps, args.task_id, args.reason)
      return { outcome: "cancellation-requested", cancelled: result.cancelled, task_ids: result.taskIds }
    },
  }
  return stopTaskTool
}

// M26-D3: cancel a task + its whole descendant tree (agentPath prefix = the
// delegation tree), durable marks in ONE doc write (registry.cancelTree —
// terminalizes + enqueues notifications), then interrupt the live table subtree
// (existing controller channel) and await quiescence via each entry's
// followupChain (covers the initial run + all chained followups).
export async function cancelSubtree(
  deps: SubagentToolDeps,
  taskId: string,
  reason?: string,
): Promise<{ taskIds: string[]; cancelled: number }> {
  const root = deps.tasks.get(taskId)
  if (!root) throw new Error(`unknown task: ${taskId}`)
  if (root.outcome !== undefined) return { taskIds: [], cancelled: 0 }
  const result = deps.tasks.cancelTree(taskId, reason ?? "task cancelled by owner")
  const prefix = `${root.agentPath}/`
  const entries = [...deps.table.entries().values()].filter(
    (e) => e.path === root.agentPath || e.path.startsWith(prefix),
  )
  for (const e of entries) {
    e.controller.abort()
    if (e.jobId) deps.jobs.kill(e.jobId)
  }
  await Promise.allSettled(entries.map((e) => e.followupChain ?? Promise.resolve()))
  return result
}
