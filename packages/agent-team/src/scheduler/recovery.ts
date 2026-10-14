import type { Tool, ToolExec, ToolRegistry } from "@i-harness/core-tools"
import type { TeamSubagentDeps } from "../scheduler.ts"
import type { TeamFoldState } from "../fold.ts"
import type { createActivity } from "../activity.ts"
import type { TeamCaller } from "../types.ts"
import { AgentPath } from "../agent-path.ts"

// The spawn checkpoint flushes first; crash reconciliation reads the existing
// durable log without invoking load/loadOwned repair on a running child.
export function createDurabilityProbes(sub: Pick<TeamSubagentDeps, "childSessions">) {
  const realHoldsPrompt = (sessionId: string, signal?: AbortSignal): Promise<boolean> =>
    probeChildDurable(sub.childSessions, sessionId, signal, { flushFirst: true })
  const realIsDurable = (sessionId: string, signal?: AbortSignal): Promise<boolean> =>
    probeChildDurable(sub.childSessions, sessionId, signal, { flushFirst: false })
  return { realHoldsPrompt, realIsDurable }
}

async function probeChildDurable(
  childSessions: TeamSubagentDeps["childSessions"],
  sessionId: string,
  signal?: AbortSignal,
  opts?: { flushFirst?: boolean },
): Promise<boolean> {
  if (!childSessions) return false // no durable child sessions → cannot prove durability
  if (signal?.aborted) return false
  // A durability probe observes a potentially RUNNING child. load() performs
  // crash repair and commits closers, which would shift the durable sequence
  // underneath its live mirror. Never substitute recovery for this read.
  if (!childSessions.coordinator.snapshot) return false
  try {
    if (opts?.flushFirst) await childSessions.coordinator.flush(sessionId)
    const { session } = await childSessions.coordinator.snapshot(sessionId)
    if (signal?.aborted) return false
    const events = session.events
    if (events.some((e) => e.type === "user/message")) return true
    if (events.some((e) => e.type === "subagent/inbox")) return true
    return false
  } catch {
    return false
  }
}

// Tool replacement and restoration share one map and the exact mounted list.
// This factory is called only after provisioning and queued-message recovery.
export function mountTeamTools(
  tools: ToolRegistry,
  teamTools: Tool[],
  state: TeamFoldState,
  sub: Pick<TeamSubagentDeps, "table" | "agents" | "jobs">,
  toolDeps: { resolveCaller(exec: ToolExec): TeamCaller },
) {
  const replaced = new Map<string, NonNullable<ReturnType<ToolRegistry["get"]>>>()
  const mountedTools: Tool[] = [...teamTools]
  const closeAgent = tools.get("close_agent")
  if (closeAgent) mountedTools.push({
    ...closeAgent,
    execute: async (args, exec) => {
      const target = (args as { target: string }).target
      const historical = [...state.members.values()].find(member => member.sessionId
        && AgentPath.parse(`lead/${member.name}`).toString() === target)
      // Older shutdowns removed the runtime table while the durable roster
      // survived. Closing that exact known member is already complete; never
      // fabricate a runtime or a live status just to satisfy management.
      if (historical && !sub.table.get(target) && !sub.agents.get(historical.sessionId!)) {
        toolDeps.resolveCaller(exec)
        return { previous_status: "inactive" }
      }
      return closeAgent.execute(args, exec)
    },
  })
  for (const t of mountedTools) {
    const existing = tools.get(t.name)
    if (existing) {
      replaced.set(t.name, existing)
      tools.unregister(t.name)
    }
    tools.register(t)
  }

  // The latch stays at the facade; all consumers use these same live reads.
  return (activity: Pick<ReturnType<typeof createActivity>, "close">, completionJobs: Set<Promise<unknown>>, isUnmounted: () => boolean, markUnmounted: () => void, release: () => void) => {
    const unmount = async (): Promise<void> => {
      if (isUnmounted()) return
      markUnmounted()
      try {
        // release every waiter first (wait_agent must not hang past unmount)
        activity.close()
        await Promise.allSettled([...completionJobs])
        // tear down live teammate children best-effort: abort + unmount scope
        // + kill job + drop from table/agents (mirrors subagent close_agent).
        // Only lead/* entries belong to this team — regular subagents (root/*)
        // are untouched.
        for (const [path, entry] of [...sub.table.entries()]) {
          if (!path.startsWith("lead/")) continue
          try {
            sub.table.update(path, entry, { closing: true })
            entry.controller.abort()
            if (entry.dispose) await entry.dispose()
            else { await entry.followupChain?.catch(() => {}); entry.unmount?.() }
            if (entry.jobId) sub.jobs.kill(entry.jobId)
            if (sub.table.get(path) === entry) sub.table.remove(path)
            if (entry.sessionId) sub.agents.remove(entry.sessionId)
          } catch {
            // best-effort teardown: one broken child must not block unmount
          }
        }
        for (const tool of mountedTools) tools.unregister(tool.name)
        // reverse of the collision replacement: restore the pre-mount tool
        for (const tool of replaced.values()) tools.register(tool)
      } finally {
        release()
      }
    }
    return unmount
  }
}
