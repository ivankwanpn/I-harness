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

// Non-team events (turn/start/…) may appear interleaved in a lead session log.
// They are skipped so real lead sessions can be folded; the watermark stays a
// raw index into the passed array, keeping incremental replays consistent.
function isTeamEvent(event: unknown): event is TeamEvent {
  return typeof (event as { type?: unknown })?.type === "string" && (event as { type: string }).type.startsWith("team/")
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
  switch (event.type) {
    case "team/member": {
      if (event.member.phase === "provisioning") {
        if (state.members.has(event.member.name)) throw new Error(`agent-team: member name reused: ${event.member.name}`)
        state.members.set(event.member.name, event.member)
        return
      }
      const existing = state.members.get(event.member.name)
      if (!existing) throw new Error(`agent-team: member ${event.member.name} must start provisioning`)
      if (existing.phase === "provisioning" && event.member.phase === "active") { state.members.set(event.member.name, event.member); return }
      if (existing.phase === "provisioning" && event.member.phase === "failed") { state.members.set(event.member.name, event.member); return }
      if (existing.phase === "active" && event.member.phase === "active") return // idempotent settle
      throw new Error(`agent-team: invalid member transition ${existing.phase}->${event.member.phase} for ${event.member.name}`)
    }
    case "team/task": {
      if (event.task.revision === 1) {
        if (state.tasks.has(event.task.id)) throw new Error(`agent-team: duplicate task id ${event.task.id}`)
        state.tasks.set(event.task.id, event.task)
        return
      }
      const existing = state.tasks.get(event.task.id)
      if (!existing) throw new Error(`agent-team: task ${event.task.id} must start at revision 1`)
      if (event.task.revision !== existing.revision + 1) throw new Error(`agent-team: task ${event.task.id} revision must increment by 1`)
      state.tasks.set(event.task.id, event.task)
      return
    }
    case "team/message/queued": {
      const list = state.queued.get(event.message.targetId) ?? []
      if (list.some((m) => m.id === event.message.id)) throw new Error(`agent-team: duplicate queued message ${event.message.id}`)
      list.push(event.message)
      state.queued.set(event.message.targetId, list)
      return
    }
    case "team/message/delivered": {
      const list = state.queued.get(event.targetId)
      if (!list || !list.some((m) => m.id === event.messageId)) throw new Error(`agent-team: delivered without queued: ${event.messageId}`)
      if (state.delivered.has(event.messageId)) throw new Error(`agent-team: duplicate delivered ${event.messageId}`)
      const q = list.find((m) => m.id === event.messageId)!
      if (q.targetId !== event.targetId) throw new Error(`agent-team: delivered target mismatch for ${event.messageId}`)
      state.delivered.add(event.messageId)
      return
    }
  }
}
