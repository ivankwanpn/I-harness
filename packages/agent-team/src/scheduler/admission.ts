import { randomUUID } from "node:crypto"
import { validateTeamConfig, type TeamConfig, type TeamEvent, type TeamCaller } from "../types.ts"
import { foldTeam, teamLedger, type TeamFoldState } from "../fold.ts"
import type { ToolExec } from "@i-harness/core-tools"
import type { TeamDeps, TeamSubagentDeps } from "../scheduler.ts"
import type { createRoster } from "../roster.ts"

// One module-level reservation set for every mount facade.
const liveTeams = new Set<string>()

export function admitTeam(deps: Pick<TeamDeps, "allowConcurrentTeams" | "parentSession">, config?: Partial<TeamConfig>) {
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

  if (liveTeams.size > 0 && !deps.allowConcurrentTeams) {
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
  const ledger = teamLedger(deps.parentSession)
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
  if (liveTeams.has(teamId)) throw new Error("agent-team: this team is already mounted")
  liveTeams.add(teamId)
  return { cfg, state, teamId }
}

export function releaseTeam(teamId: string): void {
  liveTeams.delete(teamId)
}

// Keep the host and subagent references live; read session identity per call.
export function resolveTeamCaller(
  exec: ToolExec,
  teamId: string,
  state: TeamFoldState,
  sub: Pick<TeamSubagentDeps, "childSessions">,
  roster: Pick<ReturnType<typeof createRoster>, "resolveCaller">,
): TeamCaller {
  const sid = exec.sessionId
  if (sid === undefined) return roster.resolveCaller(teamId, "lead")
  if (sub.childSessions && sid === sub.childSessions.parentSessionId) return roster.resolveCaller(teamId, "lead")
  const member = [...state.members.values()].find((m) => m.id === sid || m.sessionId === sid)
  if (member) return roster.resolveCaller(member.id, member.name)
  return roster.resolveCaller(teamId, "lead")
}
