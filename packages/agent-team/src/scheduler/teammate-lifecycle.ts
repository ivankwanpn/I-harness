import { spawnChild, type JobRegistry, type SubagentRole } from "@i-harness/subagent"
import type { PluginContext } from "@i-harness/core-plugin"
import type { TeamDeps, TeamSubagentDeps } from "../scheduler.ts"
import type { TeamFoldState } from "../fold.ts"
import type { createActivity } from "../activity.ts"
import { AgentPath } from "../agent-path.ts"

export const TEAMMATE_ROLE_NAME = "teammate"
export const TEAMMATE_BASE_TOOLS = ["bash", "pwsh", "read", "write", "list_dir", "grep"]

export function teammateRole(teamToolNames: string[]): SubagentRole {
  return {
    ephemeral: true,
    name: TEAMMATE_ROLE_NAME,
    description: "Team member with the team tools (no spawn/interrupt authority — the domain layer enforces Lead-only).",
    systemPrompt: "You are a teammate in an agent team. Work on the assigned task, keep the shared task board current, and communicate with the Lead or other members through the team send/followup tools.",
    tools: [...teamToolNames],
  }
}

export function createTeammateSpawner(
  ctx: PluginContext,
  deps: Pick<TeamDeps, "parentRegistry" | "parentSession" | "parentModel">,
  sub: Omit<TeamSubagentDeps, "exec" | "ensureResident">,
  teamJobs: JobRegistry,
  getTeamRoleTools: () => string[],
  activity: Pick<ReturnType<typeof createActivity>, "notify">,
) {
  const realSpawnChild = async (name: string, prompt: string, context: "fresh" | "fork", opts?: { forkTurns?: "none" | "all" | number }): Promise<{ path: string; jobId: string; sessionId?: string }> => {
    const role = sub.roles.get(TEAMMATE_ROLE_NAME) ?? teammateRole(getTeamRoleTools())
    let forkTurns: "none" | "all" | number
    if (context === "fresh") forkTurns = "none"
    else if (opts?.forkTurns === undefined || opts.forkTurns === "all") forkTurns = "all"
    else forkTurns = opts.forkTurns
    return spawnChild({
      generationFactoryFor: sub.generationFactoryFor, modelActionTimeoutMs: sub.modelActionTimeoutMs, modelActionMaxAttempts: sub.modelActionMaxAttempts,
      codeMode: sub.codeMode, codeModeFactory: sub.codeModeFactory,
      taskName: name,
      message: prompt,
      parentPath: "lead",
      parentRegistry: deps.parentRegistry,
      parentSession: deps.parentSession,
      parentCtx: ctx,
      role,
      parentModel: deps.parentModel,
      resolveModel: sub.resolveModel,
      // The role's model is decided the SAME way here as through
      // registerSubagent's chain: the declared selection and the switch ride
      // WITH the resolver. Omitted when the host passed neither — an unset
      // switch is OFF, never "enabled by omission".
      ...(sub.roleSelectionFor !== undefined ? { roleSelectionFor: sub.roleSelectionFor } : {}),
      ...(sub.allowSubagentModelSelection !== undefined ? { allowSubagentModelSelection: sub.allowSubagentModelSelection } : {}),
      ...(sub.autoCompactionEnabled ? { autoCompactionEnabled: sub.autoCompactionEnabled } : {}),
      ...(sub.inheritedSystemContext ? { inheritedSystemContext: sub.inheritedSystemContext } : {}),
      // M73: same two options, same rule — the teammate's window and cap come
      // from the session the roster belongs to, and an absent one writes no key.
      ...(sub.contextWindow !== undefined ? { contextWindow: sub.contextWindow } : {}),
      budgetBinding: sub.budgetBinding, contextMetadata: sub.contextMetadata, reasoningEffort: sub.reasoningEffort, inheritedBindingForStep: sub.inheritedBindingForStep,
      summaryFactory: sub.summaryFactory,
      ...(sub.maxOutputTokens !== undefined ? { maxOutputTokens: sub.maxOutputTokens } : {}),
      jobs: teamJobs,
      table: sub.table,
      agents: sub.agents,
      forkTurns,
      childSessions: sub.childSessions,
    }).then((out) => {
      // M19 Ruling 26 (status edge): the child's INITIAL turn completing after
      // spawn flips its status running→waiting (see child.ts) WITHOUT
      // appending any team event — the roster's spawn call had already
      // returned. A wait_agent waiter registered during the turn would never
      // be woken by the event stream, so wake it on the followup chain's
      // settle (the status handler is registered before the chain resolves).
      const spawnedEntry = sub.table.get(out.path)
      if (spawnedEntry?.followupChain) void spawnedEntry.followupChain.then(() => activity.notify()).catch(() => {})
      return out
    })
  }
  return realSpawnChild
}

export function createTeammateControls(
  sub: Pick<TeamSubagentDeps, "table" | "jobs" | "agents">,
  activity: Pick<ReturnType<typeof createActivity>, "notify">,
) {
  const realInterruptChild = async (path: string): Promise<string> => {
    const entry = sub.table.get(path)
    if (!entry) return "inactive"
    const previous = entry.status
    entry.controller.abort()
    await entry.cancel?.("Teammate interrupted")
    // M19 Ruling 26 (status edge): the aborted turn rejects and flips the
    // child's status → waiting without a team event; wake wait_agent waiters.
    if (entry.followupChain) void entry.followupChain.then(() => activity.notify()).catch(() => {})
    return previous
  }
  const realCloseChild = async (path: string): Promise<void> => {
    const entry = sub.table.get(path)
    if (!entry) return
    sub.table.update(path, entry, { closing: true })
    entry.controller.abort()
    if (entry.dispose) await entry.dispose()
    else { await entry.followupChain?.catch(() => {}); entry.unmount?.() }
    if (entry.jobId) sub.jobs.kill(entry.jobId)
    if (sub.table.get(path) === entry) sub.table.remove(path)
    if (entry.sessionId) sub.agents.remove(entry.sessionId)
  }
  return { realInterruptChild, realCloseChild }
}

export function createMemberStatus(teamId: string, state: TeamFoldState, sub: Pick<TeamSubagentDeps, "table">) {
  const realMemberStatus = (id: string): "running" | "idle" | "inactive" | "provisioning" | "failed" => {
    if (id === teamId) return "running"
    const member = [...state.members.values()].find((m) => m.id === id)
    if (!member) return "inactive"
    if (member.phase === "provisioning") return "provisioning"
    if (member.phase === "failed") return "failed"
    const entry = sub.table.get(AgentPath.parse(`lead/${member.name}`).toString())
    if (!entry) return "inactive"
    return entry.status === "running" ? "running" : entry.status === "waiting" ? "idle" : "inactive"
  }
  return realMemberStatus
}
