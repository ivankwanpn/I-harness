import { z } from "zod"

export interface TeamConfig {
  maxMembers?: number                    // default 8 (incl. ever-provisioned failed)
  maxTasks?: number                      // default 256 (non-deleted only)
  maxPendingMessagesPerMember?: number   // default 64
  maxMessageBytes?: number               // default 65536 (incl. framing)
  startupTimeoutMs?: number              // default 10_000
  waitMinMs?: number                     // default 10_000
  waitMaxMs?: number                     // default 3_600_000
  waitDefaultMs?: number                 // default 30_000
}

const POSITIVE_INT = z.number().int().positive()
export function validateTeamConfig(config: TeamConfig): void {
  const bounds: [string, number][] = [
    ["maxMembers", config.maxMembers ?? 8], ["maxTasks", config.maxTasks ?? 256],
    ["maxPendingMessagesPerMember", config.maxPendingMessagesPerMember ?? 64],
    ["maxMessageBytes", config.maxMessageBytes ?? 65_536],
    ["startupTimeoutMs", config.startupTimeoutMs ?? 10_000],
    ["waitMinMs", config.waitMinMs ?? 10_000], ["waitMaxMs", config.waitMaxMs ?? 3_600_000],
    ["waitDefaultMs", config.waitDefaultMs ?? 30_000],
  ]
  for (const [k, v] of bounds) {
    const r = POSITIVE_INT.safeParse(v)
    if (!r.success) throw new Error(`agent-team: ${k} must be a positive integer (got ${v})`)
  }
  if ((config.waitMinMs ?? 10_000) < 10_000) throw new Error("agent-team: waitMinMs must be >= 10000")
  if ((config.waitMaxMs ?? 3_600_000) > 3_600_000) throw new Error("agent-team: waitMaxMs must be <= 3600000")
}

export type TeamMemberPhase = "provisioning" | "active" | "failed"
export interface TeamMemberSnapshot {
  id: string; name: string; description: string
  provider: string; context: "fresh" | "fork"
  phase: TeamMemberPhase; error?: string
  // durable child session id (set once the child is spawned; the member id is a
  // roster-generated UUID, so recovery probes must key on this).
  sessionId?: string
}
export interface TeamMemberView {
  id: string; name: string; role: "lead" | "teammate"
  status: "running" | "idle" | "inactive" | "provisioning" | "failed"
  description?: string; context?: "fresh" | "fork"; diagnostics: string[]
}
export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted"
export interface TeamTaskSnapshot {
  id: string; revision: number; subject: string; description: string
  status: TeamTaskStatus; ownerId?: string
  blockedBy: string[]; writeScopes: string[]
}
export interface TeamTaskView extends TeamTaskSnapshot {
  ownerName?: string; ready: boolean; writeScopeWarnings: string[]
}
export interface TeamMessageSnapshot {
  id: string; senderId: string; senderName: string
  targetId: string; delivery: "quiet" | "wakeup"; content: string
}
export type TeamEvent =
  | { type: "team/member"; version: 1; teamId: string; member: TeamMemberSnapshot }
  | { type: "team/task"; version: 1; teamId: string; task: TeamTaskSnapshot }
  | { type: "team/message/queued"; version: 1; teamId: string; message: TeamMessageSnapshot }
  | { type: "team/message/delivered"; version: 1; teamId: string; messageId: string; targetId: string }

export class TeamError extends Error {
  constructor(readonly code: string, message: string) {
    super(`agent-team: ${code}: ${message}`)
    this.name = "TeamError"
  }
}
export const TEAM_CODES = {
  INVALID_CONFIG: "TEAM_INVALID_CONFIG", DISPOSED: "TEAM_DISPOSED",
  NOT_MEMBER: "TEAM_NOT_MEMBER", MEMBER_NOT_FOUND: "TEAM_MEMBER_NOT_FOUND",
  MEMBER_NAME_TAKEN: "TEAM_MEMBER_NAME_TAKEN", MEMBER_LIMIT: "TEAM_MEMBER_LIMIT",
  INVALID_MEMBER_NAME: "TEAM_INVALID_MEMBER_NAME", LEAD_REQUIRED: "TEAM_LEAD_REQUIRED",
  PROVISIONING_CONFLICT: "TEAM_PROVISIONING_CONFLICT",
  SELF_MESSAGE: "TEAM_SELF_MESSAGE", MAILBOX_FULL: "TEAM_MAILBOX_FULL",
  MESSAGE_TOO_LARGE: "TEAM_MESSAGE_TOO_LARGE",
  TASK_NOT_FOUND: "TEAM_TASK_NOT_FOUND", TASK_STALE_REVISION: "TEAM_TASK_STALE_REVISION",
  TASK_DELETED: "TEAM_TASK_DELETED", TASK_UNAUTHORIZED: "TEAM_TASK_UNAUTHORIZED",
  TASK_ALREADY_CLAIMED: "TEAM_TASK_ALREADY_CLAIMED", TASK_BLOCKED: "TEAM_TASK_BLOCKED",
  TASK_INVALID_TRANSITION: "TEAM_TASK_INVALID_TRANSITION", TASK_LIMIT: "TEAM_TASK_LIMIT",
  TASK_DEPENDENCY_CYCLE: "TEAM_TASK_DEPENDENCY_CYCLE", TASK_HAS_DEPENDENTS: "TEAM_TASK_HAS_DEPENDENTS",
  INVALID_ARGUMENT: "TEAM_INVALID_ARGUMENT", INVALID_TIMEOUT: "TEAM_INVALID_TIMEOUT",
  INVALID_WRITE_SCOPE: "TEAM_INVALID_WRITE_SCOPE",
} as const

// Team scope owner (calling agent) — resolved from the tool's entry.
export type TeamCaller = { id: string; name: string; role: "lead" | "teammate" }
