import { runningElapsedMs, type AgentTable } from "./agent-table.ts"

export interface StaleSubagentsSectionOptions {
  /** The live agent table — the same projection the subagent tools read. */
  table: AgentTable
  /** A RUNNING child whose current run has lasted at least this many ms is
   * listed. Required, never defaulted here: the value is the assembly's knob
   * (`AssemblyOptions.subagentStaleAfterMs`) and one default is enough. */
  thresholdMs: number
}

/** W11 — the UNASKED path: a runtime-context section naming the sub-agents
 * that have been running past `thresholdMs`.
 *
 * The property that decides whether this is usable (W11's brief names it as
 * the deciding one): runtime-context renders a snapshot ONLY when its text
 * CHANGES
 * (`packages/runtime-context/src/index.ts`), so a section whose text counts
 * time upward would append a log line every tick — noise, not signal. So the
 * text is a function of THE SET of stale children and nothing else: their
 * paths, their role/job, and the threshold (a constant). The elapsed itself is
 * NOT here — it moves continuously — and the reader is pointed at
 * `list_agents`, whose row carries the exact number. One log line per
 * crossing, one per leaving, zero in between.
 *
 * Nothing here starts a turn (a settled Q2 decision, not a design choice): the
 * getter is only ever called from `agent/pre-step`, i.e. during turns the
 * session is already taking.
 *
 * It also does not suppose: an entry that is running but carries no start
 * stamp is reported as UNKNOWN rather than as healthy (W11's no-silent-
 * degradation rule) — a section that quietly skipped it would render as "no
 * agent needs attention", which is a claim this function cannot make. */
export function createStaleSubagentsSection(opts: StaleSubagentsSectionOptions): () => string {
  return () => {
    const now = Date.now()
    const stale: string[] = []
    const unknown: string[] = []
    for (const entry of opts.table.entries().values()) {
      // A filter, not the rule: `runningElapsedMs` answers "how long" (and
      // returns undefined for a settled entry too), so the two cases it
      // collapses have to be told apart here.
      if (entry.status !== "running") continue
      const elapsed = runningElapsedMs(entry, now)
      const who = `${entry.path} (role ${entry.roleName ?? "general"}${entry.jobId !== undefined ? `, job ${entry.jobId}` : ""})`
      if (elapsed === undefined) unknown.push(`- ${entry.path}: running, but no start time was recorded — elapsed unknown (a harness defect, not a healthy agent)`)
      else if (elapsed >= opts.thresholdMs) stale.push(`- ${who}`)
    }
    // Sorted, so the text is a function of the SET rather than of Map insertion
    // order: an unrelated spawn must not move this snapshot.
    stale.sort()
    unknown.sort()
    const lines: string[] = []
    if (stale.length > 0) {
      lines.push(`Sub-agents running longer than ${formatDuration(opts.thresholdMs)} (${stale.length}):`)
      lines.push(...stale)
      lines.push("Call list_agents for each one's exact elapsed; a long run is not by itself a fault.")
    }
    if (unknown.length > 0) {
      lines.push("Sub-agent runs with no start time recorded:")
      lines.push(...unknown)
    }
    return lines.join("\n")
  }
}

/** The threshold is a CONSTANT, so rendering it can never move the snapshot —
 * the reason it is allowed here while the elapsed values are not. Private: the
 * section is its only caller. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return `${ms}`
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const restSeconds = seconds % 60
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m${restSeconds}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`
}
