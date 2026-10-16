import { diagnosticsFor } from "@i-harness/diagnostics"
import type { AgentTable } from "../agent-table.ts"
import type { SubagentToolDeps } from "../tools/types.ts"
import { driveFollowups } from "./drive.ts"
import { ensureResidentAgent, followupDepsWithRebuild } from "./resident.ts"

// W6 T6: ONE module-scope handle for this file's one report; the phase is
// `session` because the site is the cold-resume sweep (a session restored from
// its durable log re-drains a child's queued inbox, and one child's failed
// sweep must not break the host's resume). With nothing installed the handle
// delegates to console.warn verbatim (one argument) — unset mode is the
// pre-migration bytes.
const d = diagnosticsFor("session")

// M24a (G4): pending-inbox sweep for cold resume. After the sync restoreState
// rebuilds the agent table (Ruling M24a-P2) and the G1a mirror step has
// reloaded each child's durable log into a live mirror (index.ts
// restoreMirrorsAndSweep), entries that were WAITING with a queued-but-
// unconsumed durable inbox event (seq > lastInboxSeq) get the same serialized
// followup drain a live wakeup would have given them. Guards:
//   - ONLY "waiting" entries are swept (Ruling M24a-P6): entries that were
//     running were already mapped to "error" by restoreState and need an
//     explicit resume_agent; completed/killed/error entries have no live
//     conversation to resume.
//   - A failed resident rebuild is skipped conservatively (the followup
//     wakeup paths rebuild lazily later; the sweep itself must never throw).
// Exported for direct testing: the drive is fire-and-forget (same semantics
// as followup_task), so a caller asserting the OUTCOME awaits
// entry.followupChain.
export async function sweepPendingInbox(deps: SubagentToolDeps, table: AgentTable): Promise<void> {
  for (const entry of table.entries().values()) {
    if (entry.status !== "waiting" || !entry.sessionId) continue
    const hasPending = entry.session.events.some(
      (e) => e.type === "subagent/inbox" && (e.seq ?? 0) > (entry.lastInboxSeq ?? -1),
    )
    if (!hasPending) continue
    if (!deps.agents.get(entry.sessionId)) {
      const ok = await ensureResidentAgent(deps, entry)
      if (!ok) continue // rebuild failed → skip (conservative; wakeup paths may retry lazily)
    }
    void driveFollowups(followupDepsWithRebuild(deps), entry, entry.sessionId).catch(() => {
      // fail-visible log, not throw: one child's failed sweep must not break
      // the host resume (the error stays on the entry for wait_agent /
      // job_output to surface).
      d.warn(`[subagent] pending inbox sweep failed for ${entry.sessionId}`)
    })
  }
}
