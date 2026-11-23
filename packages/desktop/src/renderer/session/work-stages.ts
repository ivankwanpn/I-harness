import type { TimelineItem } from "./activity-groups.ts"
import type { GenerationReading } from "./project.ts"
export interface WorkStage { kind: "work-stage"; id: string; count: number; expanded: boolean; generation?: GenerationReading }
export type WorkItem = TimelineItem | WorkStage

/** A stage hides intermediate work only. Headers/children stay flat so the
 * existing virtualizer, rather than a giant nested DOM, still bounds rendering. */
export function workStages(items: readonly TimelineItem[], open: ReadonlyMap<string, boolean>): WorkItem[] {
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
    const last = segment.findLast((row) => row.kind === "message" || row.kind === "tool" || row.kind === "activity-group" || (row.kind === "other" && row.label === "reasoning"))
    const finalId = last?.kind === "message" && last.role === "assistant" && !last.transient ? last.id : undefined
    // Thinking, commentary, tools and background inputs share the same ordered
    // work disclosure. The first thought remains a collapsed hint inside it.
    const work = (row: TimelineItem) => row.id !== finalId && row.kind !== "outcome" && row.kind !== "failure"
      && !(row.kind === "message" && row.role === "user")
    const count = segment.filter(work).length
    const id = `work:${turn.id}`
    const expanded = open.get(id) === true
    let header = false
    for (const row of segment) {
      if (row.id === finalId && row.kind === "message" && !row.interrupted && turn.generation) {
        result.push({ ...row, generation: turn.generation })
        continue
      }
      if (!work(row)) { result.push(row); continue }
      if (!header && count) { result.push({ kind: "work-stage", id, count, expanded, generation: finalId === undefined ? turn.generation : undefined }); header = true }
      if (expanded) result.push(row)
    }
    start = end
  }
  return result
}
