// M19 Task 10: mount/unmount lifecycle for the Team scope — the REAL subagent
// wiring (Rulings 4 / 17-21). The plan's sketch is a skeleton; here every
// bridge the domain layer needs (roster/mailbox) is bound to the live subagent
// machinery: spawnChild with durable child-<uuid> sessions, durability probes
// via coordinator.snapshot, interrupt/close via the agent table, and message
// delivery through the child's durable session mirror.

import { type FactOwner, type SessionView as Session } from "@i-harness/core-session"
import { createTeamFacts, teamFactOwner } from './facts.ts'
import type { PluginContext } from "@i-harness/core-plugin"

import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { AgentRegistry } from "@i-harness/core-agent"
import type { ExecService } from "@i-harness/exec"
import type { ToolRegistry, ToolExec } from "@i-harness/core-tools"
import type { AgentTable, ChildAgentEntry, JobRegistry, ParentInputAdmission, RoleRegistry, SpawnOptions, SubagentRole } from "@i-harness/subagent"
import type { TeamConfig } from "./types.ts"
import { admitTeam, releaseTeam, resolveTeamCaller } from "./scheduler/admission.ts"
import { TEAMMATE_BASE_TOOLS, TEAMMATE_ROLE_NAME, teammateRole, createTeammateSpawner, createTeammateControls, createMemberStatus } from "./scheduler/teammate-lifecycle.ts"
import { createCompletionJobs } from "./scheduler/completion.ts"
import { createTaskDelivery } from "./scheduler/task-delivery.ts"
import { createDurabilityProbes, mountTeamTools } from "./scheduler/recovery.ts"

import { createTeamTransact } from "./transact.ts"
import { createRoster } from "./roster.ts"
import { createMailbox } from "./mailbox.ts"
import { createTaskBoard } from "./task-board.ts"
import { createActivity } from "./activity.ts"
import { createTeamTools } from "./tools.ts"
import { AgentPath } from "./agent-path.ts"

export interface TeamSubagentDeps {
  reportPolicy?: import("@i-harness/subagent").ReportPolicy
  retainResults?: () => Promise<"durable" | "memory">
  table: AgentTable
  jobs: JobRegistry
  roles: RoleRegistry
  // M19 Ruling 17: live Agent instances registry (created by registerSubagent)
  // — the wakeup bridge needs the resident Agent instance for followup
  // re-drives.
  agents: AgentRegistry
  exec: ExecService
  /** Forwarded verbatim to `spawnChild` — see SpawnOptions.resolveModel. */
  resolveModel: SpawnOptions["resolveModel"]
  /** Forwarded verbatim to `spawnChild` too — the host's declared role models
   * and the `plugins.subagentModel` switch. WITHOUT them a spawned teammate
   * silently inherits the parent's client: the declared selection collapses to
   * the role's own `model` (undefined for a settings-declared entry), so the
   * gate never fires and no message is produced — while the SAME teammate's
   * wakeup rebuild (ensureResident, wired with the full deps) resolves the
   * declared one. One teammate, two models, no surface saying so. */
  roleSelectionFor?: SpawnOptions["roleSelectionFor"]
  allowSubagentModelSelection?: SpawnOptions["allowSubagentModelSelection"]
  autoCompactionEnabled?: SpawnOptions["autoCompactionEnabled"]
  inheritedSystemContext?: SpawnOptions["inheritedSystemContext"]
  codeMode?: SpawnOptions["codeMode"]
  codeModeFactory?: SpawnOptions["codeModeFactory"]
  /** M73: the session's own model's numbers, mirrored from SpawnOptions the way
   * the two fields above are. A teammate with no declared model runs on the
   * session's model, so its requests are clamped and measured against the same
   * window and cap — the roster's spawn and the spawn_agent tool must not
   * disagree about what the same session's budget is. Absent → no key written. */
  contextWindow?: SpawnOptions["contextWindow"]
  budgetBinding?: SpawnOptions["budgetBinding"]
  contextMetadata?: SpawnOptions["contextMetadata"]
  reasoningEffort?: SpawnOptions["reasoningEffort"]
  inheritedBindingForStep?: SpawnOptions["inheritedBindingForStep"]
  summaryFactory?: SpawnOptions['summaryFactory']
  maxOutputTokens?: SpawnOptions["maxOutputTokens"]
  // M8 durable child sessions: coordinator + parent session id. When present,
  // spawned teammates get durable child-<uuid> sessions (lineage header) and
  // their inbox appends go through the write-behind mirror. WITHOUT it the
  // roster's durability gate fails closed (no sessionId → no durable proof).
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
  // M23 (Minor 4): lazy resident rebuild injection — wired by run.ts from
  // registerSubagent's ensureResident closure (TeamSubagentDeps has NO
  // parentCtx/parentRegistry/parentModel, so the scheduler cannot rebuild a
  // teammate itself). When present, realDeliver may rebuild a post-resume
  // teammate (restoreState maps running/waiting → "error" and the Agent
  // registry is fresh-empty) instead of dropping the drive; absent keeps the
  // conservative behavior (message stays queued).
  ensureResident?: (entry: ChildAgentEntry) => Promise<boolean>
}

export interface TeamDeps {
  parentNotify?: ParentInputAdmission
  /** Desktop sessions own independent team tool registries and ledgers. */
  allowConcurrentTeams?: boolean
  preserveSubagentTools?: boolean
  // lead session (the team's parent/main session; its event log is the team
  // log — every team/* event is appended here)
  parentSession: Session
  factOwner?: FactOwner
  parentRegistry: ToolRegistry
  subagents: TeamSubagentDeps
  parentModel: ModelClient
  // Test-only override seams (Ruling 20): the scheduler uses the REAL subagent
  // binding when an override is absent. They keep the lifecycle test real
  // without spawning processes.
  spawnChild?: (name: string, prompt: string, context: "fresh" | "fork", opts?: { forkTurns?: "none" | "all" | number }) => Promise<{ path: string; jobId: string; sessionId?: string }>
  childSessionHoldsPrompt?: (sessionId: string, signal?: AbortSignal) => Promise<boolean>
  childSessionIsDurable?: (sessionId: string, signal?: AbortSignal) => Promise<boolean>
  interruptChild?: (path: string) => Promise<string>
  closeChild?: (path: string) => Promise<void>
  deliver?: (targetId: string, messageId: string, content: string, delivery: "quiet" | "wakeup", signal?: AbortSignal) => Promise<boolean>
  memberStatus?: (id: string) => string
}

export interface TeamMountHandle {
  teamName: string
  unmount(): Promise<void>
  drainLeadMessages?(): Promise<void>
}

export async function mountAgentTeams(
  ctx: PluginContext,
  tools: ToolRegistry,
  deps: TeamDeps,
  config?: Partial<TeamConfig>,
): Promise<TeamMountHandle> {
  // config validation BEFORE anything is reserved (fail-closed, no side effects)
  const { cfg, state, teamId } = admitTeam(deps, config)
  let unmounted = false
  let generatedRole: SubagentRole | undefined
  const removeGeneratedRole = () => {
    if (generatedRole && deps.subagents.roles.get(TEAMMATE_ROLE_NAME) === generatedRole) deps.subagents.roles.remove(TEAMMATE_ROLE_NAME)
  }
  // Every failure path below must release the reservation — the idempotent
  // unmount flag plus this catch keeps a mid-mount throw from leaking it.
  try {
    const sub = deps.subagents
    const { completionJobs, teamJobs } = createCompletionJobs(sub, state, cfg, () => unmounted, () => mailbox, () => activity)
    let teamToolNames: string[] = []
    // Teammate role tool surface (Minor 5): derived from the CREATED team tools
    // (Ruling 19 discipline) minus the Lead-only ones; populated right after
    // createTeamTools below — spawns only ever happen post-mount, so the
    // closure reads the final value.
    let teamRoleTools: string[] = [...TEAMMATE_BASE_TOOLS, ...(tools.get("shell") ? ["shell"] : [])]
    const activity = createActivity({ waitMinMs: cfg.waitMinMs, waitMaxMs: cfg.waitMaxMs, waitDefaultMs: cfg.waitDefaultMs })
    const lead = createTeamFacts(teamFactOwner(deps.parentSession,deps.factOwner),()=>tx.drain(),()=>activity.notify())
    const tx = createTeamTransact(lead, state)

    // ---- real bridge bindings (Ruling 18) ----

    const realSpawnChild = createTeammateSpawner(ctx, deps, sub, teamJobs, () => teamRoleTools, activity)
    const spawnChildFn = deps.spawnChild ?? realSpawnChild

    const { realHoldsPrompt, realIsDurable } = createDurabilityProbes(sub)
    const holdsPrompt = deps.childSessionHoldsPrompt ?? realHoldsPrompt
    const isDurable = deps.childSessionIsDurable ?? realIsDurable

    const { realInterruptChild, realCloseChild } = createTeammateControls(sub, activity)
    const interruptChild = deps.interruptChild ?? realInterruptChild
    const closeChild = deps.closeChild ?? realCloseChild

    const realMemberStatus = createMemberStatus(teamId, state, sub)
    const memberStatus = deps.memberStatus ?? realMemberStatus

    const realDeliver = createTaskDelivery(teamId, state, deps, sub, teamJobs, activity, () => unmounted)
    const deliver = deps.deliver ?? realDeliver

    // ---- build the domain ----
    const roster = createRoster({
      teamId,
      state,
      transact: tx,
      spawnChild: spawnChildFn,
      childSessionHoldsPrompt: holdsPrompt,
      childSessionIsDurable: isDurable,
      interruptChild,
      closeChild,
      maxMembers: cfg.maxMembers,
      startupTimeoutMs: cfg.startupTimeoutMs,
      memberStatus,
      memberJobId: id => {
        const member = [...state.members.values()].find(row => row.id === id)
        return member ? sub.table.get(AgentPath.parse(`lead/${member.name}`).toString())?.jobId : undefined
      },
    })
    const mailbox = createMailbox({
      teamId,
      state,
      transact: tx,
      deliver,
      memberStatus: (id) => memberStatus(id) as "running" | "idle" | "inactive" | "provisioning" | "failed",
      maxPendingMessagesPerMember: cfg.maxPendingMessagesPerMember,
      maxMessageBytes: cfg.maxMessageBytes,
    })
    const taskBoard = createTaskBoard({ teamId, state, transact: tx, maxTasks: cfg.maxTasks })

    const toolDeps = {
      resolveCaller: (exec: ToolExec) => resolveTeamCaller(exec, teamId, state, sub, roster),
      roster,
      mailbox,
      taskBoard,
      activity,
    }
    const collisions = new Set(["send_message", "followup_task", "wait_agent", "interrupt_agent"])
    const teamTools = createTeamTools(toolDeps).map(tool=>({...tool,execute:(args:unknown,exec:ToolExec)=>lead.run(exec.abortSignal,()=>Promise.resolve(tool.execute(args,exec)))})).map((tool) => deps.preserveSubagentTools && collisions.has(tool.name)
      ? { ...tool, name: `team_${tool.name}` } : tool)
    // Tool names DERIVED from the created tools (Ruling 19) — mount and
    // unmount can never drift from each other or from Task 9's surface.
    teamToolNames = teamTools.map((t) => t.name)
    // Minor 5: the teammate role's tool surface derives from the SAME tool
    // list — all team tools minus the two Lead-only ones (spawn_teammate /
    // interrupt_agent). Never hardcode the 10 names in two places.
    teamRoleTools = [...TEAMMATE_BASE_TOOLS, ...(tools.get("shell") ? ["shell"] : []), ...teamToolNames.filter((n) => n !== "spawn_teammate" && n !== "interrupt_agent" && n !== "team_interrupt_agent")]
    // A restored child retains roleName="teammate" and rebuilds through the
    // shared registry. Publish the generated live role without saving it as a
    // user role; an existing custom definition remains authoritative.
    if (!sub.roles.get(TEAMMATE_ROLE_NAME)) {
      generatedRole = teammateRole(teamRoleTools)
      sub.roles.register(generatedRole)
    }

    // ---- recovery (crash restore), BEFORE the tools are live ----
    // (a) reconcile stuck provisioning members (provisioning→active if the
    //     child session is durable, else failed) — CROSS-TASK CARRY (Ruling 11).
    await roster.reconcileProvisioning()
    // (b) replay queued−delivered messages to their targets (at-least-once).
    await mailbox.recoverRoot()

    // ---- register the tools ----
    const bindUnmount = mountTeamTools(tools, teamTools, state, sub, toolDeps)

    const unmount = bindUnmount(activity, completionJobs, () => unmounted, () => { unmounted = true }, () => {
      removeGeneratedRole()
      releaseTeam(teamId)
    })
    return { teamName: teamId, async unmount(){await lead.close();await unmount()}, drainLeadMessages: async () => { if (!unmounted) await mailbox.recoverRoot(teamId) } }
  } catch (err) {
    removeGeneratedRole()
    releaseTeam(teamId)
    throw err
  }
}
