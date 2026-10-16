import type { JobRegistry } from "@i-harness/subagent"
import type { TeamSubagentDeps } from "../scheduler.ts"
import type { TeamConfig } from "../types.ts"
import type { TeamFoldState } from "../fold.ts"
import type { createMailbox } from "../mailbox.ts"
import type { createActivity } from "../activity.ts"

// Completion tracking has one owner. Mailbox/activity are bound at their
// original allocation points, and are only read when a job actually settles.
export function createCompletionJobs(
  sub: Pick<TeamSubagentDeps, "jobs" | "table" | "reportPolicy" | "retainResults">,
  state: TeamFoldState,
  cfg: Required<TeamConfig>,
  isUnmounted: () => boolean,
  getMailbox: () => Pick<ReturnType<typeof createMailbox>, "sendMessage">,
  getActivity: () => Pick<ReturnType<typeof createActivity>, "notify">,
) {
  const completionJobs = new Set<Promise<unknown>>()
  const completionCounts = new Map<string, number>()
  const teamJobs: JobRegistry = { ...sub.jobs, updateJob(id, patch) {
    let wasRunning = false
    try { wasRunning = sub.jobs.read(id).status === "running" } catch { /* preserve unknown-job semantics */ }
    const updated = sub.jobs.updateJob(id, patch)
    if (!updated || !wasRunning || isUnmounted() || (patch.status !== "completed" && patch.status !== "error")) return updated
    const entry = [...sub.table.entries()].find(([path, row]) => path.startsWith("lead/") && row.jobId === id)
    if (!entry || entry[1].controller.signal.aborted) return updated
    const name = entry[0].slice("lead/".length)
    const member = state.members.get(name)
    if (!member || member.phase === "failed") return updated
    const count = (completionCounts.get(id) ?? 0) + 1
    completionCounts.set(id, count)
    const turn = entry[1].session.events.findLast((event) => event.type === "turn/end")?.seq ?? count
    const header = `Team result <${entry[1].sessionId ?? id}:${turn}> from <${name}> (${patch.status}):\n`
    // Mailbox framing uses a fixed-length UUID. Bound only the notification;
    // the complete job output remains available through job_output.
    const framing = `Team message <msg-${"0".repeat(36)}> from <${name}>:\n`
    const framingBytes = Buffer.byteLength(framing, "utf8")
    const output = patch.output ?? ""
    const maxBytes = Math.min(cfg.maxMessageBytes, sub.reportPolicy?.maxReportBytes ?? cfg.maxMessageBytes)
    let content = `${header}${output}`
    let displayBody = output
    if (framingBytes + Buffer.byteLength(content, "utf8") > maxBytes || (sub.reportPolicy && (Buffer.byteLength(output, "utf8") > sub.reportPolicy.childPreviewBytes || Buffer.byteLength(JSON.stringify(framing + content + "\n[Result retention: durable]"), "utf8") > maxBytes))) {
      const footer = `\n[Result truncated; full output: job_output({job_id:${JSON.stringify(id)}})]`
      const budget = Math.min(sub.reportPolicy?.childPreviewBytes ?? maxBytes, Math.max(0, maxBytes - framingBytes - Buffer.byteLength(header + footer, "utf8")))
      const bytes = Buffer.from(output, "utf8")
      let end = Math.min(budget, bytes.length)
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
      // Charge final JSON escaping and the retention notice as well as mailbox
      // framing. Temporary/raw character budgets alone undercount NULs/quotes.
      if (sub.reportPolicy) {
        while (end > 0 && Buffer.byteLength(JSON.stringify(framing + header + bytes.subarray(0, end).toString("utf8") + footer + "\n[Result retention: durable]"), "utf8") > maxBytes) {
          end = Math.floor(end / 2)
          while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
        }
      }
      const summary = bytes.subarray(0, end).toString("utf8")
      content = `${header}${summary}${footer}`
      displayBody = sub.reportPolicy ? output : `${summary}\n[Result truncated; full output is available in job output]`
    }
    const job = (async () => {
      if (sub.reportPolicy) {
        sub.table.update(entry[0], entry[1], { retention: "pending", retentionError: undefined })
        const retention = await sub.retainResults?.() ?? "memory"
        sub.table.update(entry[0], entry[1], { retention })
        // Disposal/Stop retains the completed output but cannot admit a wake.
        if (isUnmounted() || entry[1].controller.signal.aborted) return
        content += `\n[Result retention: ${retention}]`
        if (Buffer.byteLength(JSON.stringify(framing + content), "utf8") > maxBytes) throw new Error("Team result metadata exceeds report budget")
      }
      return getMailbox().sendMessage({ id: member.id, name, role: "teammate" }, "lead", content, "quiet", undefined, {
        kind: "team-result", title: `${patch.status === "completed" ? "Team reply ended" : "Team reply error"}: ${name}`, body: displayBody,
      })
    })()
    completionJobs.add(job)
    void job.catch(error => {
      if (sub.reportPolicy) sub.table.update(entry[0], entry[1], { retention: entry[1].retention === "pending" ? "failed" : entry[1].retention, retentionError: error instanceof Error ? error.message : String(error) })
    }).finally(() => { completionJobs.delete(job); getActivity().notify() })
    return updated
  } }
  return { completionJobs, teamJobs }
}
