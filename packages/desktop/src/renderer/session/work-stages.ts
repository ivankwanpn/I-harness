import type { TimelineItem } from "./activity-groups.ts"
export interface WorkStage { kind: "work-stage"; id: string; count: number }
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
    // Only an ended turn's last substantive assistant message is treated as
    // final. A prior commentary followed by a tool is still intermediate work.
    let finalId: string | undefined
    if (turn.complete) {
      const last = segment.filter((row) => row.kind !== "outcome").at(-1)
      if (last?.kind === "message" && last.role === "assistant" && !last.transient) finalId = last.id
    }
    const work = (row: TimelineItem) => row.id !== finalId && row.kind !== "outcome" && !(row.kind === "message" && row.role === "user")
    const count = segment.filter(work).length
    const id = `work:${turn.id}`
    let header = false
    for (const row of segment) {
      if (!work(row)) { result.push(row); continue }
      if (!header && count) { result.push({ kind: "work-stage", id, count }); header = true }
      if (open.get(id) !== false) result.push(row)
    }
    start = end
  }
  return result
}
