import type { Tool } from "@i-harness/core-tools"
import type { SubagentToolDeps } from "./types.ts"
import { userSteerForTool, waitForObservation } from "@i-harness/core-tools"

export function createWaitTool(deps: SubagentToolDeps): Tool {
  const waitTool: Tool<{ timeout_ms?: number; target?: string }, { message: string; timed_out: boolean; path?: string; status?: string; finalText?: string; error?: string; session_id?: string; job_id?: string; yielded?: true; yield_reason?: "user-steer" | "target-changed" }> = {
    name: "wait_agent",
    description: "Wait for subagents to settle. With target, observes that exact child and returns its summary; otherwise observes all live subagents. New user input yields the wait while work continues; removal or replacement returns target-changed. Only a deadline reports timed_out.",
    inputSchema: { type: "object", properties: { timeout_ms: { type: "number", description: "Max wait in ms (default 30000, clamped to 100..300000)." }, target: { type: "string", description: "Optional agent path — wait for this specific subagent instead of all." } } },
    isReadOnly: true,
    execute: async (args, exec) => {
      const timeoutMs = Math.min(300_000, Math.max(100, args.timeout_ms ?? 30_000))
      const observe = (ready: () => boolean) => waitForObservation({
        ready, changes: { subscribe: wake => deps.table.subscribe(wake) }, timeoutMs,
        abortSignal: exec.abortSignal, userSteer: userSteerForTool(exec),
      })
      if (args.target !== undefined) {
        const target = args.target, entry = deps.table.get(target)
        if (!entry) throw new Error(`unknown subagent: ${target}`)
        const reason = await observe(() => deps.table.get(target) !== entry || entry.status !== "running")
        exec.abortSignal?.throwIfAborted()
        const changed = deps.table.get(target) !== entry
        const settled = entry.status !== "running"
        const yieldReason = changed ? "target-changed" as const : !settled && reason === "user-steer" ? "user-steer" as const : undefined
        const message = changed ? `wait yielded: target ${entry.path} was removed or replaced`
          : settled ? `subagent ${entry.path} settled: ${entry.status}`
          : yieldReason ? `wait yielded to new user input for ${entry.path} (still running)`
          : reason === "deadline" ? `wait timed out for ${entry.path} (still running)`
          : `subagent ${entry.path} changed state and is currently running`
        return {
          path: entry.path, status: entry.status,
          ...(entry.sessionId ? { session_id: entry.sessionId } : {}), ...(entry.jobId ? { job_id: entry.jobId } : {}),
          ...(entry.finalText !== undefined ? { finalText: entry.finalText } : {}),
          ...(entry.error !== undefined ? { error: entry.error } : {}),
          ...(entry.retention !== undefined ? { retention: entry.retention } : {}),
          ...(entry.retentionError !== undefined ? { retention_error: entry.retentionError } : {}),
          ...(yieldReason ? { yielded: true as const, yield_reason: yieldReason } : {}),
          message,
          timed_out: !changed && !settled && reason === "deadline",
        }
      }
      const running = () => [...deps.table.entries().values()].some(entry => entry.status === "running")
      const reason = await observe(() => !running())
      exec.abortSignal?.throwIfAborted()
      if (!running()) return deps.reportPolicy
        ? { message: `All ${deps.table.entries().size} subagents settled; use list_agents for paged reports.`, timed_out: false }
        : { message: `All subagents settled: ${[...deps.table.entries().keys()].join(", ") || "(none)"}`, timed_out: false }
      if (reason === "user-steer") return { message: "wait yielded to new user input; subagents continue running", timed_out: false, yielded: true as const, yield_reason: "user-steer" as const }
      return { message: reason === "deadline" ? "wait timed out with subagents still running" : "Subagent state changed; some subagents are currently running", timed_out: reason === "deadline" }
    },
  }
  return waitTool
}

export function createTaskOutputTool(deps: SubagentToolDeps): Tool {
  const getTaskOutputTool: Tool<
    { task_ids: string[]; wait?: boolean; timeout_ms?: number },
    { tasks: { task_id: string; status: string; outcome?: string; agent_path: string; description: string; resultText?: string; error?: string; time_created: number }[]; yielded?: true; yield_reason?: "user-steer" }
  > = {
    name: "get_task_output",
    description: "Read the durable output of 1..20 subagent tasks (task ids). wait: true observes all until terminal or new user input (timeout_ms clamped 100..600000). An id this session does not own fails identically to an unknown id (task or otherwise).",
    inputSchema: {
      type: "object",
      properties: {
        task_ids: { type: "array", items: { type: "string" }, description: "1..20 task ids." },
        wait: { type: "boolean", description: "Wait until every task is terminal (default false = snapshot only)." },
        timeout_ms: { type: "number", description: "Max wait in ms (default 30000, clamped 100..600000)." },
      },
      required: ["task_ids"],
    },
    isReadOnly: true,
    execute: async (args, exec) => {
      if (!Array.isArray(args.task_ids) || args.task_ids.length < 1 || args.task_ids.length > 20) {
        throw new Error("get_task_output expects between 1 and 20 task ids")
      }
      // Ownership gate: EVERY id must be owned by this registry — a non-owned id
      // (foreign session, shell job, malformed) fails identically to an unknown
      // task: nothing here distinguishes them (R-D6 no-oracle posture).
      for (const taskId of args.task_ids) {
        if (!deps.tasks.get(taskId)) throw new Error(`unknown task: ${taskId}`)
      }
      const timeoutMs = Math.min(600_000, Math.max(100, args.timeout_ms ?? 30_000))
      const ready = () => args.task_ids.every(id => deps.tasks.get(id)!.outcome !== undefined)
      const reason = args.wait === true ? await waitForObservation({
        ready, timeoutMs, abortSignal: exec.abortSignal, userSteer: userSteerForTool(exec),
        changes: { subscribe: wake => {
          const offs: (() => void)[] = []
          const cleanup = () => {
            const errors: unknown[] = []
            for (const off of offs.splice(0)) { try { off() } catch (error) { errors.push(error) } }
            if (errors.length) throw new AggregateError(errors, "Task observation cleanup failed")
          }
          try { for (const id of args.task_ids) offs.push(deps.tasks.subscribe(id, wake)) }
          catch (error) {
            try { cleanup() } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Task observation setup failed") }
            throw error
          }
          return cleanup
        } },
      }) : undefined
      exec.abortSignal?.throwIfAborted()
      return {
        ...(reason === "user-steer" && !ready() ? { yielded: true as const, yield_reason: "user-steer" as const } : {}),
        tasks: args.task_ids.map((taskId) => {
          const t = deps.tasks.get(taskId)!
          return {
            task_id: t.id,
            status: t.status,
            ...(t.outcome !== undefined ? { outcome: t.outcome } : {}),
            agent_path: t.agentPath,
            description: t.description,
            ...(t.resultText !== undefined ? { resultText: t.resultText } : {}),
            ...(t.error !== undefined ? { error: t.error } : {}),
            time_created: t.timeCreated,
          }
        }),
      }
    },
  }
  return getTaskOutputTool
}
