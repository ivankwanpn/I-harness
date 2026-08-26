import { z } from "zod"
import type { TeamEvent, TeamMemberSnapshot, TeamTaskSnapshot, TeamMessageSnapshot } from "./types.ts"

export interface TeamFoldState {
  members: Map<string, TeamMemberSnapshot>          // by name
  tasks: Map<string, TeamTaskSnapshot>              // by id (incl tombstone)
  queued: Map<string, TeamMessageSnapshot[]>        // by targetId (FIFO)
  delivered: Set<string>                            // messageId
  nextTaskNumber: number                            // for task-<uuid> counters (kept simple — uuid suffix)
}
export function createFoldState(): TeamFoldState {
  return { members: new Map(), tasks: new Map(), queued: new Map(), delivered: new Set(), nextTaskNumber: 1 }
}

// Spec §4.5 structure validation: strict zod schemas for the 4 team event
// types (version 1). `seq`/`ignorable` are infra fields added by core-session
// on persist, so they are allowed for real lead-session log replay.
const TEAM_EVENT_SCHEMA = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("team/member"), version: z.literal(1), teamId: z.string(),
    member: z.strictObject({
      id: z.string(), name: z.string(), description: z.string(),
      provider: z.string(), context: z.enum(["fresh", "fork"]),
      phase: z.enum(["provisioning", "active", "failed"]), error: z.string().optional(),
      sessionId: z.string().optional(),
    }),
    seq: z.number().optional(), ignorable: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("team/task"), version: z.literal(1), teamId: z.string(),
    task: z.strictObject({
      id: z.string(), revision: z.number().int().positive(), subject: z.string(),
      description: z.string(), status: z.enum(["pending", "in_progress", "completed", "deleted"]),
      ownerId: z.string().optional(), blockedBy: z.array(z.string()), writeScopes: z.array(z.string()),
    }),
    seq: z.number().optional(), ignorable: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("team/message/queued"), version: z.literal(1), teamId: z.string(),
    message: z.strictObject({
      id: z.string(), senderId: z.string(), senderName: z.string(), targetId: z.string(),
      delivery: z.enum(["quiet", "wakeup"]), content: z.string(),
    }),
    seq: z.number().optional(), ignorable: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("team/message/delivered"), version: z.literal(1), teamId: z.string(),
    messageId: z.string(), targetId: z.string(),
    seq: z.number().optional(), ignorable: z.boolean().optional(),
  }),
])

// Non-team events (turn/start/…) may appear interleaved in a lead session log.
// They are skipped so real lead sessions can be folded; the watermark stays a
// raw index into the passed array, keeping incremental replays consistent.
function isTeamEvent(event: unknown): event is TeamEvent {
  return typeof (event as { type?: unknown })?.type === "string" && (event as { type: string }).type.startsWith("team/")
}

// Spec §4.5: structural violations THROW (never enter state). Unknown team/*
// types and version !== 1 are rejected too.
function validateTeamEvent(event: unknown): TeamEvent {
  const r = TEAM_EVENT_SCHEMA.safeParse(event)
  if (!r.success) {
    const type = typeof (event as { type?: unknown })?.type === "string" ? (event as { type: string }).type : "unknown"
    const detail = r.error.issues[0]?.message ?? "invalid structure"
    throw new Error(`agent-team: invalid ${type} event: ${detail}`)
  }
  return r.data as TeamEvent
}

// foldTeam is the full-replay recovery path: it folds the complete log into a
// fresh state (design spec §3.4 "恢復：coordinator.load(leadId) → foldTeam(events)").
// The incremental path is the caller holding a TeamFoldState and applying new
// events via applyTeamEvent (spec §3.4 "对 session.events.slice(watermark) 重放").
// opts.watermark is a consistency guard rather than a skip index: folding the
// full log is always correct regardless of prior folds, and a watermark beyond
// the log length indicates the log shrank (corruption). The returned watermark
// is the log length, so callers can resume incremental folding afterwards.
export function foldTeam(events: TeamEvent[], opts?: { watermark?: number }): { state: TeamFoldState; watermark: number } {
  const start = opts?.watermark ?? 0
  if (start > events.length) throw new Error(`agent-team: watermark ${start} exceeds log length ${events.length}`)
  const state = createFoldState()
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (!isTeamEvent(event)) continue
    applyTeamEvent(state, event)
  }
  return { state, watermark: events.length }
}

export function applyTeamEvent(state: TeamFoldState, event: TeamEvent): void {
  if (!isTeamEvent(event)) return // graceful skip for mixed session logs
  const valid = validateTeamEvent(event) // spec §4.5: structure validated, violation throws
  switch (valid.type) {
    case "team/member": {
      if (valid.member.phase === "provisioning") {
        if (state.members.has(valid.member.name)) throw new Error(`agent-team: member name reused: ${valid.member.name}`)
        state.members.set(valid.member.name, valid.member)
        return
      }
      const existing = state.members.get(valid.member.name)
      if (!existing) throw new Error(`agent-team: member ${valid.member.name} must start provisioning`)
      // spec §4.5: identity (id/name/description/provider/context) immutable
      const IDENTITY_FIELDS = ["id", "name", "description", "provider", "context"] as const
      for (const f of IDENTITY_FIELDS) {
        if (valid.member[f] !== existing[f]) throw new Error(`agent-team: member identity immutable for ${valid.member.name}: ${f} changed`)
      }
      if (existing.phase === "provisioning" && valid.member.phase === "active") { state.members.set(valid.member.name, valid.member); return }
      if (existing.phase === "provisioning" && valid.member.phase === "failed") { state.members.set(valid.member.name, valid.member); return }
      if (existing.phase === "active" && valid.member.phase === "active") return // idempotent settle
      throw new Error(`agent-team: invalid member transition ${existing.phase}->${valid.member.phase} for ${valid.member.name}`)
    }
    case "team/task": {
      if (valid.task.revision === 1) {
        if (state.tasks.has(valid.task.id)) throw new Error(`agent-team: duplicate task id ${valid.task.id}`)
        state.tasks.set(valid.task.id, valid.task)
        return
      }
      const existing = state.tasks.get(valid.task.id)
      if (!existing) throw new Error(`agent-team: task ${valid.task.id} must start at revision 1`)
      if (valid.task.revision !== existing.revision + 1) throw new Error(`agent-team: task ${valid.task.id} revision must increment by 1`)
      state.tasks.set(valid.task.id, valid.task)
      return
    }
    case "team/message/queued": {
      const list = state.queued.get(valid.message.targetId) ?? []
      if (list.some((m) => m.id === valid.message.id)) throw new Error(`agent-team: duplicate queued message ${valid.message.id}`)
      list.push(valid.message)
      state.queued.set(valid.message.targetId, list)
      return
    }
    case "team/message/delivered": {
      const list = state.queued.get(valid.targetId)
      if (!list || !list.some((m) => m.id === valid.messageId)) throw new Error(`agent-team: delivered without queued: ${valid.messageId}`)
      if (state.delivered.has(valid.messageId)) throw new Error(`agent-team: duplicate delivered ${valid.messageId}`)
      const q = list.find((m) => m.id === valid.messageId)!
      if (q.targetId !== valid.targetId) throw new Error(`agent-team: delivered target mismatch for ${valid.messageId}`)
      state.delivered.add(valid.messageId)
      return
    }
  }
}
