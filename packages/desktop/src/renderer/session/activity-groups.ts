import type { TimelineRow } from "./project.ts"
export type ToolRow = Extract<TimelineRow, { kind: "tool" }>
export interface ActivityGroupRow { id: string; kind: "activity-group"; family: "explore" | "execute" | "changes"; rows: ToolRow[]; turn?: TimelineRow["turn"] }
export type TimelineItem = TimelineRow | ActivityGroupRow
function family(row: TimelineRow): ActivityGroupRow["family"] | undefined {
  if (row.kind !== "tool") return undefined
  if (["read", "read_file", "glob", "grep", "list_dir", "tool_search"].includes(row.name)) return "explore"
  if (["bash", "pwsh", "shell"].includes(row.name)) return "execute"
  if (["write", "write_file", "edit", "apply_patch"].includes(row.name)) return "changes"
  return undefined
}
/** Presentation only. Groups never cross a readable message/reasoning boundary
 * or infer shell permissions. Identity is anchored to the first actual call. */
export function groupActivities(rows: readonly TimelineRow[]): TimelineItem[] {
  const result: TimelineItem[] = []
  for (let index = 0; index < rows.length;) {
    const first = rows[index]!
    const kind = family(first)
    let end = index + 1
    if (kind && first.kind === "tool") while (end < rows.length && family(rows[end]!) === kind && (rows[end] as ToolRow).groupScope === first.groupScope) end++
    if (kind && end - index > 1) result.push({ id: `activity:${first.id}`, kind: "activity-group", family: kind, rows: rows.slice(index, end) as ToolRow[], ...(first.turn ? { turn: first.turn } : {}) })
    else result.push(first)
    index = end
  }
  return result
}
