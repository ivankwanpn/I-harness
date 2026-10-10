import type { TimelineRow } from "../session/project.ts"
import type { TextDiff } from "../../../../text-diff/src/index.ts"
import { recordedDiffs, toolFamily, toolState } from "../session/tool-presentation.ts"

export interface SessionChangeEntry { id: string; toolId: string; turnId?: string; diff: TextDiff; failed: boolean }
export interface SessionChanges { entries: SessionChangeEntry[]; latestTurnId?: string }

/** Recorded file operations, independent of current Git status. */
export function buildSessionChanges(rows: readonly TimelineRow[]): SessionChanges {
  const entries: SessionChangeEntry[] = []
  let latestTurnId: string | undefined
  for (const row of rows) {
    if (row.turn) latestTurnId = row.turn.id
    if (row.kind !== "tool" || !row.resultReceived || toolFamily(row.name) !== "write") continue
    const state = toolState(row.name, row.output, row.resultReceived, row.isError, row.dispatched)
    const failed = state === "failed" || state === "cancelled" || state === "stopped" || state === "interrupted"
    for (const [index, diff] of recordedDiffs(row.output).entries()) {
      if (!diff.path.trim()) continue
      entries.push({ id: JSON.stringify([row.id, index]), toolId: row.id, ...(row.turn ? { turnId: row.turn.id } : {}), diff, failed })
    }
  }
  return { entries, ...(latestTurnId ? { latestTurnId } : {}) }
}
