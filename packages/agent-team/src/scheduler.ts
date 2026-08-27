// M19 Task 10: mount/unmount lifecycle for the Team scope — the REAL subagent
// wiring (Rulings 4 / 17-21). The plan's sketch is a skeleton; here every
// bridge the domain layer needs (roster/mailbox) is bound to the live subagent
// machinery: spawnChild with durable child-<uuid> sessions, durability probes
// via coordinator.load, interrupt/close via the agent table, and message
// delivery through the child's durable session mirror.
import { randomUUID } from "node:crypto"
import { append, type Session } from "@i-harness/core-session"
import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry, ToolExec } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { AgentRegistry } from "@i-harness/core-agent"
import type { ExecService } from "@i-harness/exec"
import type { ProviderRegistry } from "@i-harness/provider"
import {
  driveFollowups,
  spawnChild,
  type AgentTable,
  type ChildAgentEntry,
  type FollowupDeps,
  type JobRegistry,
  type RoleRegistry,
  type SubagentRole,
} from "@i-harness/subagent"
import { validateTeamConfig, type TeamConfig, type TeamEvent, type TeamCaller } from "./types.ts"
import { foldTeam } from "./fold.ts"
import { createTeamTransact, type TeamLead } from "./transact.ts"
import { createRoster } from "./roster.ts"
import { createMailbox } from "./mailbox.ts"
import { createTaskBoard } from "./task-board.ts"
import { createActivity } from "./activity.ts"
import { createTeamTools } from "./tools.ts"
import { AgentPath } from "./agent-path.ts"

export interface TeamSubagentDeps {
  table: AgentTable
  jobs: JobRegistry
  roles: RoleRegistry
  // M19 Ruling 17: live Agent instances registry (created by registerSubagent)
  // — the wakeup bridge needs the resident Agent instance for followup
  // re-drives.
  agents: AgentRegistry
  exec: ExecService
  providers: ProviderRegistry
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
  // lead session (the team's parent/main session; its event log is the team
  // log — every team/* event is appended here)
  parentSession: Session
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
}

// Module-level reservation (M17/M18 pattern): one team per run. A second mount
// is a hard error, not a silent shadow; released on unmount.
const liveTeams = new Set<string>()

const TEAMMATE_ROLE_NAME = "teammate"
// A synthesized default role for teammates when no "teammate" role was
// registered: the working tool base PLUS the 10 team tools, so the teammate's
// child scope can actually use the team surface (the roster.spawnChild bridge
// resolves these names from the parent registry at spawn time — same registry
// the team tools were registered on).
const TEAMMATE_BASE_TOOLS = ["bash", "pwsh", "read", "write", "list_dir", "grep"]

export async function mountAgentTeams(
  ctx: PluginContext,
  tools: ToolRegistry,
  deps: TeamDeps,
  config?: Partial<TeamConfig>,
): Promise<TeamMountHandle> {
  // config validation BEFORE anything is reserved (fail-closed, no side effects)
  const cfg: Required<TeamConfig> = {
    maxMembers: 8,
    maxTasks: 256,
    maxPendingMessagesPerMember: 64,
    maxMessageBytes: 65_536,
    startupTimeoutMs: 10_000,
    waitMinMs: 10_000,
    waitMaxMs: 3_600_000,
    waitDefaultMs: 30_000,
    ...config,
  }
  validateTeamConfig(cfg)

  if (liveTeams.size > 0) {
    throw new Error("agent-team: only one team per run is supported (M19)")
  }

  // ---- domain over the SHARED folded state (restore path) ----
  // The team log lives in the parent (lead) session events. foldTeam is a
  // full replay (spec §3.4) so a crash-recovered mount sees every committed
  // member/message/task; the transact is seeded with that same state so
  // recovery transitions re-validate against prior events. The CANONICAL
  // teamId is derived from the log: on restore the first team/* event's
  // teamId is authoritative (member ids and old-lead-targeted queued message
  // keys are stable; only a freshly minted lead id would strand them).
  const ledger = deps.parentSession.events as unknown as TeamEvent[]
  const state = foldTeam(ledger).state
  let canonicalTeamId: string | undefined
  for (const e of ledger) {
    const t = (e as { type?: unknown }).type
    if (typeof t === "string" && t.startsWith("team/")) {
      canonicalTeamId = (e as TeamEvent).teamId
      break
    }
  }
  const teamId = canonicalTeamId ?? `lead-${randomUUID()}`
  liveTeams.add(teamId)
  let unmounted = false
  // Every failure path below must release the reservation — the idempotent
  // unmount flag plus this catch keeps a mid-mount throw from leaking it.
  try {
    const sub = deps.subagents
    let teamToolNames: string[] = []
    // Teammate role tool surface (Minor 5): derived from the CREATED team tools
    // (Ruling 19 discipline) minus the Lead-only ones; populated right after
    // createTeamTools below — spawns only ever happen post-mount, so the
    // closure reads the final value.
    let teamRoleTools: string[] = [...TEAMMATE_BASE_TOOLS]
    const activity = createActivity({ waitMinMs: cfg.waitMinMs, waitMaxMs: cfg.waitMaxMs, waitDefaultMs: cfg.waitDefaultMs })
    const lead: TeamLead = {
      // every team event is appended into the parent session log; the parent's
      // mirror hook (run.ts createSession(onAppend)) persists it through the
      // write-behind, so the team log is durable WITH the parent session log.
      append: (e) => append(deps.parentSession, e),
      // M19 Ruling 25: the coordinator's flush on the parent session IS the
      // durability point — mirror the child-message deliver branch (below) so
      // onCommit fires only after a REAL flush. Without childSessions (no
      // coordinator) there is nothing to flush; the mirror hook is the write
      // through the write-behind and the flush is a no-op there.
      flush: () => sub.childSessions
        ? sub.childSessions.coordinator.flush(sub.childSessions.parentSessionId)
        : Promise.resolve(),
      // onCommit is invoked by the transact AFTER lead.flush() resolves, i.e.
      // at the durable-commit point — mirror dsh's journal onCommit rule:
      // waiters may only be woken for committed state (spec §4.4/§4.7).
      onCommit: () => activity.notify(),
    }
    const tx = createTeamTransact(lead, state)

    // ---- real bridge bindings (Ruling 18) ----

    // spawnChild: map the roster call onto the subagent's spawnChild with the
    // lead lineage (path lead/<name>, durable child-<uuid> session).
    // M19 Ruling 27: forkTurns derives from the roster's context selector PLUS
    // the op-level fork_turns opt — "fresh" → none (regardless), "fork" →
    // opts.forkTurns ?? "all" (number or "none" pass through).
    const realSpawnChild = async (name: string, prompt: string, context: "fresh" | "fork", opts?: { forkTurns?: "none" | "all" | number }): Promise<{ path: string; jobId: string; sessionId?: string }> => {
      const role = sub.roles.get(TEAMMATE_ROLE_NAME) ?? teammateRole(teamRoleTools)
      let forkTurns: "none" | "all" | number
      if (context === "fresh") forkTurns = "none"
      else if (opts?.forkTurns === undefined || opts.forkTurns === "all") forkTurns = "all"
      else forkTurns = opts.forkTurns
      return spawnChild({
        taskName: name,
        message: prompt,
        parentPath: "lead",
        parentRegistry: deps.parentRegistry,
        parentSession: deps.parentSession,
        parentCtx: ctx,
        role,
        parentModel: deps.parentModel,
        providers: sub.providers,
        jobs: sub.jobs,
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
    const spawnChildFn = deps.spawnChild ?? realSpawnChild

    // childSessionHoldsPrompt / childSessionIsDurable: the child's DURABLE log
    // must hold the initial user/message (from the spawn prompt). Probe via the
    // coordinator: load(sessionId) succeeds AND a user/message (or
    // subagent/inbox) event is present. Any failure (unknown session, lost
    // log, truncated prompt, absent childSessions) returns false (fail closed).
    // The spawn checkpoint (holdsPrompt) FLUSHES first — the spawn returns
    // before the write-behind drains, so the durability barrier is what proves
    // the prompt is on disk; the reconcile probe (isDurable) is used at mount
    // after a crash where the backend is already authoritative.
    const realHoldsPrompt = (sessionId: string, signal?: AbortSignal): Promise<boolean> =>
      probeChildDurable(sub.childSessions, sessionId, signal, { flushFirst: true })
    const realIsDurable = (sessionId: string, signal?: AbortSignal): Promise<boolean> =>
      probeChildDurable(sub.childSessions, sessionId, signal, { flushFirst: false })
    const holdsPrompt = deps.childSessionHoldsPrompt ?? realHoldsPrompt
    const isDurable = deps.childSessionIsDurable ?? realIsDurable

    // interruptChild / closeChild: mirrors subagent tools.ts — interrupt aborts
    // the current turn (child stays alive, inbox preserved); close aborts +
    // unmounts the child scope + kills the job + removes table/agent entries.
    const realInterruptChild = async (path: string): Promise<string> => {
      const entry = sub.table.get(path)
      if (!entry) return "inactive"
      const previous = entry.status
      entry.controller.abort()
      // M19 Ruling 26 (status edge): the aborted turn rejects and flips the
      // child's status → waiting without a team event; wake wait_agent waiters.
      if (entry.followupChain) void entry.followupChain.then(() => activity.notify()).catch(() => {})
      return previous
    }
    const realCloseChild = async (path: string): Promise<void> => {
      const entry = sub.table.get(path)
      if (!entry) return
      entry.controller.abort()
      entry.unmount?.()
      if (entry.jobId) sub.jobs.kill(entry.jobId)
      sub.table.remove(path)
      if (entry.sessionId) sub.agents.remove(entry.sessionId)
    }
    const interruptChild = deps.interruptChild ?? realInterruptChild
    const closeChild = deps.closeChild ?? realCloseChild

    // memberStatus: lead → running; a member in a transient folded phase
    // (provisioning/failed) reports that phase; otherwise the live subagent
    // table entry maps running→running, waiting→idle, else→inactive; a member
    // with no live child → inactive.
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
    const memberStatus = deps.memberStatus ?? realMemberStatus

    // deliver: write the message durably into the target's session BEFORE
    // returning true (ack semantics — the mailbox appends team/message/delivered
    // only after this resolves true; a false keeps the message queued for
    // recoverRoot replay). Lead target → the parent session log (its mirror
    // persists it) + notify; teammate target → subagent/inbox into the child's
    // session THROUGH its mirror (durable), then wake when delivery="wakeup".
    const realDeliver = async (targetId: string, messageId: string, content: string, delivery: "quiet" | "wakeup", _signal?: AbortSignal): Promise<boolean> => {
      if (targetId === teamId) {
        // Lead is always live: durably record the message in the parent session
        // log (subagent/inbox-style event; the parent's mirror persists it).
        // Flush the parent's write-behind so the ack means on-disk.
        append(deps.parentSession, { type: "subagent/inbox", messageId, message: content })
        if (sub.childSessions) {
          try {
            await sub.childSessions.coordinator.flush(sub.childSessions.parentSessionId)
          } catch {
            // FAIL CLOSED (Ruling 22): the flush is the durability point — a
            // rejection means the message may still be in the volatile
            // write-behind. Returning true would let the mailbox append
            // delivered and recoverRoot skip this id forever. False keeps it
            // queued (at-least-once) for a recoverRoot retry.
            return false
          }
        }
        activity.notify()
        return true
      }
      const member = [...state.members.values()].find((m) => m.id === targetId)
      if (!member) return false
      const entry = sub.table.get(AgentPath.parse(`lead/${member.name}`).toString())
      // No live child (or a dead one): return false so the mailbox keeps the
      // message queued — recoverRoot re-delivers once the child is alive again
      // (e.g. after resume_agent).
      // M23 (Minor 4): a post-resume teammate carries status "error"
      // (restoreState maps running/waiting → "error") with a fresh-empty
      // Agent registry. With the rebuild seam injected, rebuild the resident
      // agent FIRST and proceed only on success; without the seam keep the
      // conservative message-stays-queued behavior.
      if (!entry) return false
      if (entry.status === "error") {
        if (!sub.ensureResident) return false
        const ok = await sub.ensureResident(entry)
        if (!ok) return false
      }
      if (entry.status === "killed") return false
      // Durable inbox write: append through the child's mirror (spawnChild's
      // session hook enqueues every append to the coordinator write-behind),
      // then update the live mailbox mirror.
      append(entry.session, { type: "subagent/inbox", messageId, message: content })
      entry.mailbox.push(content)
      // FLUSH BEFORE ACK: true must mean the message is on disk in the target's
      // session (binding: "durably in the target's session before returning
      // true"). A crash right after this returns true must not lose it — the
      // mailbox's delivered marker is only appended after this resolves.
      if (entry.sessionId && sub.childSessions) {
        try {
          await sub.childSessions.coordinator.flush(entry.sessionId)
        } catch {
          // FAIL CLOSED (Ruling 22): see the lead branch — flush rejection ⇒
          // not durably delivered ⇒ return false so the message stays queued.
          return false
        }
      }
      if (delivery === "wakeup" && entry.sessionId) {
        // Wake: drive the serialized followup chain (shared with subagent via
        // the exported driveFollowups, M19 Ruling 28 — NOT a duplicate vendor)
        // — only AFTER the append above, so the message is durably in the
        // target's session before the child sees it.
        // M23 (Minor 4): pass the rebuild seam through as driveFollowups'
        // optional `rebuild` so the drain recovers a missing resident agent
        // even when the gate above did not rebuild (e.g. a waiting entry whose
        // registry entry was dropped). Without the seam this is the unchanged
        // sub object (structural FollowupDeps).
        const wakeDeps: FollowupDeps = sub.ensureResident
          ? { ...sub, rebuild: (e: ChildAgentEntry) => sub.ensureResident!(e) }
          : sub
        const chain = driveFollowups(wakeDeps, entry, entry.sessionId)
        // M19 Ruling 26: the followup drain flips the child's status
        // (waiting→running→waiting); a wait_agent waiter must wake on that
        // edge even though no team event is appended.
        void chain.then(() => activity.notify()).catch(() => {})
      }
      return true
    }
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

    // Exact calling identity (Ruling 24): the ToolExec sessionId is now wired
    // through child.ts (seedToolExecs) for every agent — the lead runs with the
    // parent (active) session id, a teammate with its durable child session id.
    // Resolve THAT to the exact caller: the parent session id → Lead; a known
    // member session id → that member (roster id + name); anything else has no
    // team-scoped identity and falls back to the Lead (an unknown domain must
    // never impersonate a phantom teammate). The old behavior — every call
    // resolving to the Lead — misattributed teammate tool calls to the lead and
    // made "lead" look like a teammate's self-target (false TEAM_SELF_MESSAGE).
    const toolDeps = {
      resolveCaller: (exec: ToolExec): TeamCaller => {
        const sid = exec.sessionId
        if (sid === undefined) return roster.resolveCaller(teamId, "lead")
        if (sub.childSessions && sid === sub.childSessions.parentSessionId) return roster.resolveCaller(teamId, "lead")
        const member = [...state.members.values()].find((m) => m.id === sid || m.sessionId === sid)
        if (member) return roster.resolveCaller(member.id, member.name)
        return roster.resolveCaller(teamId, "lead")
      },
      roster,
      mailbox,
      taskBoard,
      activity,
    }
    const teamTools = createTeamTools(toolDeps)
    // Tool names DERIVED from the created tools (Ruling 19) — mount and
    // unmount can never drift from each other or from Task 9's surface.
    teamToolNames = teamTools.map((t) => t.name)
    // Minor 5: the teammate role's tool surface derives from the SAME tool
    // list — all team tools minus the two Lead-only ones (spawn_teammate /
    // interrupt_agent). Never hardcode the 10 names in two places.
    teamRoleTools = [...TEAMMATE_BASE_TOOLS, ...teamToolNames.filter((n) => n !== "spawn_teammate" && n !== "interrupt_agent")]

    // ---- recovery (crash restore), BEFORE the tools are live ----
    // (a) reconcile stuck provisioning members (provisioning→active if the
    //     child session is durable, else failed) — CROSS-TASK CARRY (Ruling 11).
    await roster.reconcileProvisioning()
    // (b) replay queued−delivered messages to their targets (at-least-once).
    await mailbox.recoverRoot()

    // ---- register the tools ----
    // Four team tool names (send_message / followup_task / wait_agent /
    // interrupt_agent) collide with the subagent surface on the SAME parent
    // registry when the CLI's registerSubagent ran first (M9 — spec §5 keeps
    // the subagent 11 for non-team delegation while the team versions are
    // 團隊域專用). Within a team run the team semantics must win, so a
    // collision REPLACES the existing tool; unmount restores the replaced
    // tools, making unmount a true reverse of mount.
    const replaced = new Map<string, NonNullable<ReturnType<ToolRegistry["get"]>>>()
    for (const t of teamTools) {
      const existing = tools.get(t.name)
      if (existing) {
        replaced.set(t.name, existing)
        tools.unregister(t.name)
      }
      tools.register(t)
    }

    const unmount = async (): Promise<void> => {
      if (unmounted) return
      unmounted = true
      try {
        // release every waiter first (wait_agent must not hang past unmount)
        activity.close()
        // tear down live teammate children best-effort: abort + unmount scope
        // + kill job + drop from table/agents (mirrors subagent close_agent).
        // Only lead/* entries belong to this team — regular subagents (root/*)
        // are untouched.
        for (const [path, entry] of [...sub.table.entries()]) {
          if (!path.startsWith("lead/")) continue
          try {
            entry.controller.abort()
            entry.unmount?.()
            if (entry.jobId) sub.jobs.kill(entry.jobId)
            sub.table.remove(path)
            if (entry.sessionId) sub.agents.remove(entry.sessionId)
          } catch {
            // best-effort teardown: one broken child must not block unmount
          }
        }
        for (const name of teamToolNames) tools.unregister(name)
        // reverse of the collision replacement: restore the pre-mount tool
        for (const tool of replaced.values()) tools.register(tool)
      } finally {
        liveTeams.delete(teamId)
      }
    }
    return { teamName: teamId, unmount }
  } catch (err) {
    liveTeams.delete(teamId)
    throw err
  }
}

// Default teammate role (synthesized, NOT registered — the shared role
// registry stays untouched): working tools + the team tool surface derived at
// mount (Minor 5), resolved from the parent registry at spawnChild time.
function teammateRole(teamToolNames: string[]): SubagentRole {
  return {
    name: TEAMMATE_ROLE_NAME,
    description: "Team member with the team tools (no spawn/interrupt authority — the domain layer enforces Lead-only).",
    systemPrompt: "You are a teammate in an agent team. Work on the assigned task, keep the shared task board current, and communicate with the Lead or other members through the team send/followup tools.",
    tools: [...teamToolNames],
  }
}

// Probe a durable child session: does the log durably hold the initial
// user/message (the spawn prompt was written to the mirror) or an inbox event?
// A missing/corrupt log → false (fail closed); pre-aborted signal → false.
// flushFirst drains the live write-behind to the backend (the durability
// barrier) before loading — the spawn checkpoint happens immediately after
// spawnChild returns, before the 200 ms write-behind deadline.
async function probeChildDurable(
  childSessions: TeamSubagentDeps["childSessions"],
  sessionId: string,
  signal?: AbortSignal,
  opts?: { flushFirst?: boolean },
): Promise<boolean> {
  if (!childSessions) return false // no durable child sessions → cannot prove durability
  if (signal?.aborted) return false
  try {
    if (opts?.flushFirst) await childSessions.coordinator.flush(sessionId)
    const { session } = await childSessions.coordinator.load(sessionId)
    if (signal?.aborted) return false
    const events = session.events
    if (events.some((e) => e.type === "user/message")) return true
    if (events.some((e) => e.type === "subagent/inbox")) return true
    return false
  } catch {
    return false
  }
}

// Drain all unconsumed durable inbox events as serialized turns on the child —
// the team wakeup policy is the SAME serialized drain as subagent tools.ts,
// shared via the exported driveFollowups (M19 Ruling 28 — NOT a duplicate
// vendor). The scheduler's TeamSubagentDeps is structurally a FollowupDeps
// (agents/table/jobs), so the shared drain operates on the live child directly.
