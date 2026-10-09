import type { TimelineItem } from "./activity-groups.ts"
export interface WorkStage { kind: "work-stage"; id: string; count: number; active: boolean; hasErrors: boolean }
export type WorkItem = TimelineItem | WorkStage

/** A stage hides intermediate work only. Headers/children stay flat so the
 * existing virtualizer, rather than a giant nested DOM, still bounds rendering. */
export function workStages(items: readonly TimelineItem[], open: ReadonlyMap<string, boolean>, running = false): WorkItem[] {
  const result: WorkItem[] = []
  for (let start = 0; start < items.length;) {
    const turn = items[start]!.turn
    if (!turn) { result.push(items[start++]!); continue }
    let end = start + 1
    while (end < items.length && items[end]!.turn?.id === turn.id) end++
    const segment = items.slice(start, end)
    // A continuing conversation stays visible, including human steering and
    // commentary. Only the durable turn end creates an aggregate disclosure;
    // a transient running flag or a pause for interaction cannot settle it.
    if (!turn.complete) {
      result.push(...segment)
      start = end
      continue
    }
    // Only an ended turn's last substantive assistant message is treated as
    // final. A prior commentary followed by a tool is still intermediate work.
    let finalId: string | undefined
    if (turn.complete) {
      // Passive bookkeeping and background notices do not change which model
      // response ended the work. A later tool or thought still blocks finality.
      const last = segment.filter((row) => row.kind === "message" || row.kind === "tool" || row.kind === "activity-group" || (row.kind === "other" && row.label === "reasoning")).at(-1)
      if (last?.kind === "message" && last.role === "assistant" && !last.transient) finalId = last.id
    }
    // Thinking, commentary, tools and background inputs share the same ordered
    // work disclosure. The first thought remains a collapsed hint inside it.
    const work = (row: TimelineItem) => row.id !== finalId && row.kind !== "outcome"
      && !(row.kind === "message" && row.role === "user")
    const count = segment.filter(work).length
    const failed = (row: TimelineItem): boolean => {
      if (row.kind === "activity-group") return row.rows.some(failed)
      if (row.kind === "other") return row.label === "step/failed" || row.codeActivity?.type === "code/cell" && row.codeActivity.state === "failed"
      if (row.kind !== "tool") return false
      if (row.isError) return true
      if (!row.output || typeof row.output !== "object" || Array.isArray(row.output)) return false
      const output = row.output as Record<string, unknown>
      return output.ok === false || !!output.error || typeof output.exitCode === "number" && output.exitCode !== 0
    }
    const hasErrors = segment.some(failed)
    const id = `work:${turn.id}`
    const active = running && !turn.complete && end === items.length
    let header = false
    for (const row of segment) {
      if (!work(row)) { result.push(row); continue }
      if (!header && count) { result.push({ kind: "work-stage", id, count, active, hasErrors }); header = true }
      if (open.get(id) ?? active) result.push(row)
    }
    start = end
  }
  return result
}
