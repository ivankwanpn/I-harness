import type { SessionEvent } from "@i-harness/core-session"
import type { AgentRegistry } from "@i-harness/core-agent"
import type { AgentTable, ChildAgentEntry } from "../agent-table.ts"
import type { JobRegistry } from "../jobs.ts"

// Drain all unconsumed durable inbox events as serialized turns on the child.
// Turns are chained through entry.followupChain (one at a time, per child), a
// fresh AbortController is minted per turn so interrupt_agent targets the
// current turn, and each turn re-opens the entry's job (running -> completed /
// killed / error) so wait_agent/job_output observe the followup lifecycle.
// Exported for the agent-team scheduler (M19 Ruling 28): the team wakeup
// policy is the SAME serialized drain, shared instead of vendored.
export interface FollowupDeps {
  agents: AgentRegistry
  table: AgentTable
  jobs: JobRegistry
  // M23 (Minor 4): optional lazy rebuild — called when the resident agent is
  // missing (e.g. a restored entry after resume) so the wakeup drive recovers
  // it instead of silently no-oping. Backward-compatible: absent (the default,
  // e.g. the agent-team scheduler without the seam) keeps the old no-op.
  rebuild?: (entry: ChildAgentEntry) => Promise<boolean>
}
export function driveFollowups(deps: FollowupDeps, entry: ChildAgentEntry, sessionId: string): Promise<void> {
  const prev = entry.followupChain ?? Promise.resolve()
  const next = prev.then(async () => {
    if (entry.closing || deps.table.get(entry.path) !== entry) return
    let agent = deps.agents.get(sessionId)
    if (!agent) {
      if (!deps.rebuild) return // no rebuild ability → keep the old no-op
      const ok = await deps.rebuild(entry)
      if (!ok) return
      agent = deps.agents.get(sessionId)
      if (!agent) return
    }
    const pending = entry.session.events.filter(
      (e): e is Extract<SessionEvent, { type: "subagent/inbox" }> =>
        e.type === "subagent/inbox" && (e.seq ?? 0) > (entry.lastInboxSeq ?? -1),
    )
    for (const ev of pending) {
      if (entry.closing || deps.table.get(entry.path) !== entry) return // closed/replaced mid-drain → stop
      entry.lastInboxSeq = ev.seq ?? 0
      // Errors belong to the previous turn; a new attempt has no failure yet.
      // W11: a re-drive starts a NEW run, so the start stamp moves with the
      // status (see ChildAgentEntry.startedAt). Keeping the spawn-time stamp
      // here would report a child woken a moment ago as one that has been
      // running since it was spawned — the exact wrong answer W11's signal
      // exists to prevent.
      deps.table.update(entry.path, entry, { error: undefined, finalText: undefined, status: "running", startedAt: Date.now(), controller: new AbortController(),
        ...(entry.retention !== undefined || entry.retentionError !== undefined ? { retention: undefined, retentionError: undefined } : {}),
      })
      if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: "running", output: "" })
      try {
        const result = await agent.followup(ev.message, entry.controller.signal, { provenance: ev.provenance ?? { kind: "inherited", authority: "observation", scope: "turn", producer: "subagent.inbox", ...(entry.session.header?.parentSession ? { originSessionId: entry.session.header.parentSession } : {}) } })
        // Clear a stale error (e.g. "aborted" from an earlier interrupted
        // turn) once a followup succeeds — otherwise a misleading error would
        // persist into the M6 snapshot.
        deps.table.update(entry.path, entry, { error: undefined, status: "waiting", finalText: result.finalText })
        if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: "completed", output: result.finalText })
      } catch (err) {
        const aborted = entry.controller.signal.aborted
        deps.table.update(entry.path, entry, { status: "waiting", error: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
        if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: aborted ? "killed" : "error", output: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
      }
    }
  })
  // Defensive hardening: the body fully try/catches, but a future throwing
  // statement before the try must not reject the chain and silently kill all
  // later followups for this child.
  entry.followupChain = next.catch(() => {})
  return next
}
