import { randomUUID } from "node:crypto"
import { AgentPath } from "./agent-path.ts"
import { TeamError, TEAM_CODES, type TeamCaller, type TeamMemberSnapshot, type TeamMemberView } from "./types.ts"
import type { TeamFoldState } from "./fold.ts"
import type { TeamTransaction } from "./transact.ts"

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface RosterDeps {
  teamId: string
  // shared live folded state (created via createFoldState / foldTeam); both the
  // roster's readers and the transact observe the same object.
  state: TeamFoldState
  transact: TeamTransaction
  // subagent integration (injected; internally spawns the durable child)
  spawnChild: (name: string, prompt: string, context: "fresh" | "fork") => Promise<{ path: string; jobId: string; sessionId?: string }>
  childSessionHoldsPrompt: (sessionId: string, signal?: AbortSignal) => Promise<boolean>
  interruptChild: (path: string) => Promise<string>
  closeChild: (path: string) => Promise<void>
  maxMembers?: number
  startupTimeoutMs?: number
  // live child status accessor (subagent table entry status by member id);
  // used to map active members: running->running, waiting->idle, else->inactive.
  memberStatus?: (id: string) => string
}

// Ruling 10(c): every fn passed to deps.transact is PURE-READ — it inspects the
// state param (name reuse / maxMembers / phase guards) and returns
// { events, result }; it NEVER mutates the state. The transact runs the fn
// against a clone and validates candidates via applyTeamEvent before anything
// touches the live state or the log.
export function createRoster(deps: RosterDeps) {
  const maxMembers = deps.maxMembers ?? 8
  const startupTimeoutMs = deps.startupTimeoutMs ?? 10_000

  function callerIsLead(caller: TeamCaller): boolean {
    return caller.role === "lead"
  }

  // runtime status mapping (no event written): the member's folded phase drives
  // provisioning/failed; an active member's live child status is authoritative.
  function liveStatus(id: string): TeamMemberView["status"] {
    const raw = deps.memberStatus?.(id)
    if (raw === "running") return "running"
    if (raw === "waiting") return "idle"
    return "inactive"
  }

  function listMembers(): TeamMemberView[] {
    const lead: TeamMemberView = { id: deps.teamId, name: "lead", role: "lead", status: "running", diagnostics: [] }
    const members: TeamMemberView[] = [...deps.state.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      role: "teammate" as const,
      status: m.phase === "provisioning" ? "provisioning" : m.phase === "failed" ? "failed" : liveStatus(m.id),
      description: m.description,
      context: m.context,
      diagnostics: [],
    }))
    return [lead, ...members]
  }

  async function spawnTeammate(
    caller: TeamCaller,
    name: string,
    opts: { description: string; prompt: string; context?: "fresh" | "fork"; forkTurns?: "none" | "all" | number },
  ): Promise<TeamMemberView> {
    if (!callerIsLead(caller)) throw new TeamError(TEAM_CODES.LEAD_REQUIRED, "only the Team Lead may spawn teammates")
    if (!NAME_RE.test(name) || name.length > 64 || name === "lead") throw new TeamError(TEAM_CODES.INVALID_MEMBER_NAME, `invalid teammate name "${name}"`)
    // fast fail; the serialized transact re-checks both atomically (authoritative)
    if (deps.state.members.size >= maxMembers) throw new TeamError(TEAM_CODES.MEMBER_LIMIT, `maxMembers ${maxMembers} reached`)

    const id = `child-${randomUUID()}`
    const provisioning: TeamMemberSnapshot = { id, name, description: opts.description, provider: "spawn", context: opts.context ?? "fresh", phase: "provisioning" }
    // Provisioning event: pure-read fn — name-taken and limit checks against the
    // snapshot; nothing is mutated here.
    await deps.transact.transact((state) => {
      if (state.members.has(name)) throw new TeamError(TEAM_CODES.MEMBER_NAME_TAKEN, `member name "${name}" already taken`)
      if (state.members.size >= maxMembers) throw new TeamError(TEAM_CODES.MEMBER_LIMIT, `maxMembers ${maxMembers} reached`)
      return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: provisioning }], result: undefined }
    })

    // Spawn the durable child, then checkpoint that its session durably holds
    // the initial prompt within startupTimeoutMs.
    let spawned: { path: string; jobId: string; sessionId?: string }
    try {
      spawned = await deps.spawnChild(name, opts.prompt, provisioning.context)
      if (!spawned.sessionId) throw new Error(`child session id missing for "${name}" (durable child sessions required)`)
      const timeout = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), startupTimeoutMs)
        timer.unref()
      })
      const holds = await Promise.race([
        deps.childSessionHoldsPrompt(spawned.sessionId, new AbortController().signal),
        timeout,
      ])
      if (!holds) throw new Error("child session never durably held the initial prompt")
    } catch (e) {
      // Failed event (best-effort; keeps the roster authoritative for recovery)
      // — pure-read fn again: the transition guard is applied by the transact's
      // applyTeamEvent validation.
      const failed: TeamMemberSnapshot = { ...provisioning, phase: "failed", error: e instanceof Error ? e.message : String(e) }
      await deps.transact.transact((state) => {
        if (state.members.get(name)?.phase !== "provisioning") throw new TeamError(TEAM_CODES.PROVISIONING_CONFLICT, `member "${name}" already reconciled`)
        return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: failed }], result: undefined }
      }).catch(() => {})
      try { await deps.closeChild(AgentPath.parse(`lead/${name}`).toString()) } catch { /* best-effort */ }
      throw e
    }

    const active: TeamMemberSnapshot = { ...provisioning, phase: "active" }
    // Active event: pure-read fn; identity immutability + transition validity
    // are enforced by the transact's validation against the snapshot.
    await deps.transact.transact((state) => {
      if (state.members.get(name)?.phase !== "provisioning") throw new TeamError(TEAM_CODES.PROVISIONING_CONFLICT, `member "${name}" already reconciled`)
      return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: active }], result: undefined }
    })
    return { id: active.id, name: active.name, role: "teammate", status: liveStatus(active.id), description: active.description, context: active.context, diagnostics: [] }
  }

  async function interrupt(caller: TeamCaller, target: string): Promise<{ previousStatus: string }> {
    if (!callerIsLead(caller)) throw new TeamError(TEAM_CODES.LEAD_REQUIRED, "only the Team Lead may interrupt")
    if (target === "lead") throw new TeamError(TEAM_CODES.INVALID_ARGUMENT, "cannot interrupt the lead")
    if (!deps.state.members.has(target)) throw new TeamError(TEAM_CODES.MEMBER_NOT_FOUND, `unknown teammate "${target}"`)
    // keepInbox semantics: delegation aborts the current turn but leaves the
    // child alive with its inbox intact; no roster event is written.
    return { previousStatus: await deps.interruptChild(AgentPath.parse(`lead/${target}`).toString()) }
  }

  function resolveCaller(id: string, name: string): TeamCaller {
    if (id === deps.teamId) return { id, name: "lead", role: "lead" }
    const m = [...deps.state.members.values()].find((m) => m.id === id)
    if (m) return { id, name: m.name, role: "teammate" }
    return { id, name, role: "teammate" }
  }

  return { listMembers, spawnTeammate, interrupt, resolveCaller }
}
