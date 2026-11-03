import type { Tool, ToolExec, ToolRegistry } from "@i-harness/core-tools"
import type { TeamSubagentDeps } from "../scheduler.ts"
import type { TeamFoldState } from "../fold.ts"
import type { TeamCaller } from "../types.ts"
import { AgentPath } from "../agent-path.ts"
import { hasCommittedInitialInput } from '@i-harness/subagent'

// The spawn checkpoint flushes first; crash reconciliation reads the existing
// durable log without invoking load/loadOwned repair on a running child.
export function createDurabilityProbes(sub: Pick<TeamSubagentDeps, "childSessions"|'table'>) {
  const realHoldsPrompt = (sessionId: string, signal?: AbortSignal): Promise<boolean> =>
    probeChildDurable(sub, sessionId, signal)
  const realIsDurable = (sessionId: string, signal?: AbortSignal): Promise<boolean> =>
    probeChildDurable(sub, sessionId, signal)
  return { realHoldsPrompt, realIsDurable }
}

async function probeChildDurable(
  sub:Pick<TeamSubagentDeps,'childSessions'|'table'>,
  sessionId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const {childSessions}=sub
  if (!childSessions) return false // no durable child sessions → cannot prove durability
  if (signal?.aborted) return false
  const live=[...sub.table.entries().values()].find(entry=>entry.sessionId===sessionId)
  if(live)return hasCommittedInitialInput(live,sessionId)
  // A durability probe observes a potentially RUNNING child. load() performs
  // crash repair and commits closers, which would shift the durable sequence
  // underneath its live mirror. Never substitute recovery for this read.
  if (!childSessions.coordinator.snapshot) return false
  try {
    const { session } = await childSessions.coordinator.snapshot(sessionId)
    if (signal?.aborted) return false
    return session.events.slice(session.header?.seedLength??0).some(event=>event.type==='agent/input/admitted'&&event.intent==='user'&&event.provenance?.kind==='inherited'&&event.provenance.producer==='subagent.initial'&&event.provenance.originSessionId===session.header?.parentSession)
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
  const stages = mountedTools.map(tool => ({ tool, removed: false, installed: false, uninstalled: false, restored: false }))
  return {
    mount() {
      for (const stage of stages) {
        const existing = tools.get(stage.tool.name)
        if (existing) {
          replaced.set(stage.tool.name, existing)
          tools.unregister(stage.tool.name)
          stage.removed = true
        }
        tools.register(stage.tool)
        stage.installed = true
      }
    },
    async close() {
      const failures: unknown[] = []
      for (const stage of [...stages].reverse()) {
        try {
          if (stage.installed && !stage.uninstalled) {
            if (tools.get(stage.tool.name) === stage.tool) tools.unregister(stage.tool.name)
            stage.uninstalled = true
          }
          if (stage.removed && !stage.restored) {
            const original = replaced.get(stage.tool.name)!
            if (tools.get(stage.tool.name) !== original) tools.register(original)
            stage.restored = true
          }
        } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Team tool restoration incomplete')
    },
  }
}