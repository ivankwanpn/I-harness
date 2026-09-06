// M49 Task 7: prompt history navigation — the pure rewind math, plus the ONE
// rule that history/stash restores are undoable editor transactions (the loop
// applies every restore through PromptEditor.replaceAll — never a direct
// UTF-16 write).
//
// Model (pre-M49 shape preserved): the loop's history is an array; the index
// points at the current entry; index === entries.length is the DRAFT slot
// (the empty text a "Down past the newest entry" restore returns to).

export interface HistoryRewind {
  /** The text to restore into the editor ("" = the draft slot). */
  text: string
  /** The new index after the step. */
  index: number
}

/** The rewind of `dir=-1` (older, Up) / `dir=1` (newer, Down) from `index`.
 * Undefined = empty history (no step). Clamp semantics mirror the pre-M49
 * behavior: Up at 0 stays on the first entry; Down at the newest clears to
 * the draft slot. */
export function historyRewind(
  entries: readonly string[],
  index: number,
  dir: 1 | -1,
): HistoryRewind | undefined {
  if (entries.length === 0) return undefined
  if (dir === 1) {
    if (index >= entries.length - 1) return { text: "", index: entries.length }
    return { text: entries[index + 1]!, index: index + 1 }
  }
  const i = Math.min(entries.length - 1, Math.max(0, index - 1))
  return { text: entries[i]!, index: i }
}
