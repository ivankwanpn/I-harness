// Structured line diffs built on top of the proven `diff` library
// (structuredPatch — the algorithm/LCS/Myers engine is NOT hand-rolled).
import { structuredPatch } from "diff"

export interface DiffLine {
  kind: "context" | "add" | "delete"
  text: string
  /** literal 1-based line number in the old text (absent for added lines) */
  oldLine?: number
  /** literal 1-based line number in the new text (absent for deleted lines) */
  newLine?: number
  /** the library reported "\ No newline at end of file" for this row */
  noNewline?: boolean
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface TextDiff {
  path: string
  hunks: DiffHunk[]
  added: number
  deleted: number
  truncated: boolean
}

export interface TextDiffOptions {
  /** context lines per side; defaults to 3 */
  context?: number
}

export const DEFAULT_CONTEXT = 3
export const MAX_LINES = 50_000
export const MAX_BYTES = 2 * 1024 * 1024
// window halves used when the input exceeds the caps
const WINDOW_LINES = 10_000
// work budget for one structuredPatch run (the library's abortable timeout) —
// pathological low-similarity inputs must never block the turn
const DIFF_TIMEOUT_MS = 750
const NO_NEWLINE_MARKER = "\\ No newline at end of file"

// Logical text lines: CRLF/CR are line endings, never part of line content.
// Unified rendering always emits \n — the structured rows carry no endings.
function toLf(text: string): string {
  return text.replace(/\r\n|\r/g, "\n")
}

function rowCount(text: string): number {
  return (text.match(/\n/g) ?? []).length + 1
}

function isOversized(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > MAX_BYTES || rowCount(text) > MAX_LINES
}

export function createTextDiff(path: string, before: string, after: string, options?: TextDiffOptions): TextDiff {
  const context = Math.max(0, options?.context ?? DEFAULT_CONTEXT)
  const normBefore = toLf(before)
  const normAfter = toLf(after)
  if (isOversized(normBefore) || isOversized(normAfter)) {
    return windowedDiff(path, normBefore, normAfter, context)
  }
  return diffTexts({
    path,
    oldStr: normBefore,
    newStr: normAfter,
    context,
    truncated: false,
    oldOffset: 0,
    newOffset: 0,
  })
}

// Bounded head/tail windows: never let oversized input block the turn.
// Windows are INDEX-ALIGNED: both sides share the same head positions
// [0..N) and end-anchored tail positions, and each pair always has EQUAL
// lengths — a window of one side is never diffed against a longer window of
// the other (that fabricates deletions/additions from positional skew).
// The tail pair is diffed only when its absolute positions overlap;
// otherwise the two windows compare unrelated regions and every line would
// be fabricated as changed (e.g. a pure append above the window size).
function windowedDiff(path: string, before: string, after: string, context: number): TextDiff {
  const bRows = before.split("\n")
  const aRows = after.split("\n")
  const parts: TextDiff[] = []

  // Head pair: first min(WINDOW_LINES, lenB, lenA) rows of each side —
  // positions [0..N) on both sides.
  const headLen = Math.min(WINDOW_LINES, bRows.length, aRows.length)
  parts.push(
    diffTexts({
      path,
      oldStr: bRows.slice(0, headLen).join("\n"),
      newStr: aRows.slice(0, headLen).join("\n"),
      context,
      truncated: true,
      oldOffset: 0,
      newOffset: 0,
    }),
  )

  // Tail pair: end-anchored — the last min(tailB, tailA) rows of each side,
  // where a side's tail never overlaps its own head window.
  const m = Math.min(tailWindow(bRows).length, tailWindow(aRows).length)
  if (m > 0) {
    const bStart = bRows.length - m
    const aStart = aRows.length - m
    const overlaps = bStart < aStart + m && aStart < bStart + m
    if (overlaps) {
      parts.push(
        diffTexts({
          path,
          oldStr: bRows.slice(bStart).join("\n"),
          newStr: aRows.slice(aStart).join("\n"),
          context,
          truncated: true,
          oldOffset: bStart,
          newOffset: aStart,
        }),
      )
    }
  }

  return {
    path,
    hunks: parts.flatMap((p) => p.hunks),
    added: parts.reduce((sum, p) => sum + p.added, 0),
    deleted: parts.reduce((sum, p) => sum + p.deleted, 0),
    truncated: true,
  }
}

// The tail region of a side: the last WINDOW_LINES rows, clipped so it never
// overlaps the head window (a side smaller than WINDOW_LINES has no tail).
function tailWindow(rows: string[]): string[] {
  const size = Math.max(0, Math.min(WINDOW_LINES, rows.length - WINDOW_LINES))
  return size === 0 ? [] : rows.slice(rows.length - size)
}

interface DiffInput {
  path: string
  oldStr: string
  newStr: string
  context: number
  truncated: boolean
  oldOffset: number
  newOffset: number
}

function diffTexts(input: DiffInput): TextDiff {
  const patch = structuredPatch(input.path, input.path, input.oldStr, input.newStr, "", "", {
    context: input.context,
    timeout: DIFF_TIMEOUT_MS,
  })
  if (patch === undefined) {
    // the work budget was hit — bounded and honest: no hunks, truncated.
    return { path: input.path, hunks: [], added: 0, deleted: 0, truncated: true }
  }
  let added = 0
  let deleted = 0
  const hunks: DiffHunk[] = []
  for (const hunk of patch.hunks) {
    for (const converted of convertHunk(hunk, input.context, input.oldOffset, input.newOffset)) {
      hunks.push(converted)
      for (const line of converted.lines) {
        if (line.kind === "add") added++
        else if (line.kind === "delete") deleted++
      }
    }
  }
  return { path: input.path, hunks, added, deleted, truncated: input.truncated }
}

// Converts the library's string rows into literal DiffLine entries with
// 1-based old/new line numbers walked from the hunk header, and splits a
// merged hunk back into per-change-region hunks. The library folds two
// change regions into one hunk when the context run between them is at most
// `context*2` rows; splitting on a run boundary restores literal per-region
// hunks (each region keeps up to `context` rows of padding).
function convertHunk(
  hunk: { oldStart: number; newStart: number; lines: string[] },
  context: number,
  oldOffset: number,
  newOffset: number,
): DiffHunk[] {
  let oldLine = hunk.oldStart + oldOffset
  let newLine = hunk.newStart + newOffset
  const rows: DiffLine[] = []
  const boundaries: Array<{ old: number; new: number }> = []
  for (const raw of hunk.lines) {
    if (raw.startsWith("\\ ")) {
      // "\ No newline at end of file" annotates the previous row; it is not a
      // row of its own, so it does not advance the columns.
      const last = rows[rows.length - 1]
      if (last !== undefined) last.noNewline = true
      continue
    }
    boundaries.push({ old: oldLine, new: newLine })
    const text = raw.slice(1)
    if (raw.startsWith(" ")) {
      rows.push({ kind: "context", text, oldLine, newLine })
      oldLine++
      newLine++
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "delete", text, oldLine })
      oldLine++
    } else {
      rows.push({ kind: "add", text, newLine })
      newLine++
    }
  }

  // contiguous change regions (add/delete runs)
  const groups: Array<[number, number]> = []
  let groupStart = -1
  for (let i = 0; i < rows.length; i++) {
    const isChange = rows[i]!.kind !== "context"
    if (isChange && groupStart === -1) groupStart = i
    if (!isChange && groupStart !== -1) {
      groups.push([groupStart, i])
      groupStart = -1
    }
  }
  if (groupStart !== -1) groups.push([groupStart, rows.length])

  const cuts: number[] = []
  for (let g = 0; g + 1 < groups.length; g++) {
    const gapStart = groups[g]![1]
    const gapEnd = groups[g + 1]![0]
    const runLength = gapEnd - gapStart
    cuts.push(gapStart + Math.min(context, runLength))
  }

  let start = 0
  const result: DiffHunk[] = []
  for (const cut of [...cuts, rows.length]) {
    result.push(hunkFromRows(rows, boundaries, start, cut))
    start = cut
  }
  return result
}

function hunkFromRows(rows: DiffLine[], boundaries: Array<{ old: number; new: number }>, start: number, end: number): DiffHunk {
  const slice = rows.slice(start, end)
  const boundary = start === 0 ? boundaries[0]! : boundaries[start]!
  const headOld = slice.find((line) => line.oldLine !== undefined)
  const headNew = slice.find((line) => line.newLine !== undefined)
  const oldLines = slice.filter((line) => line.oldLine !== undefined).length
  const newLines = slice.filter((line) => line.newLine !== undefined).length
  return {
    oldStart: headOld?.oldLine ?? boundary.old,
    oldLines,
    newStart: headNew?.newLine ?? boundary.new,
    newLines,
    lines: slice,
  }
}

// Renders the structured result as one unified patch. Always \n; "\ No
// newline at end of file" is re-emitted for annotated rows.
export function renderUnifiedDiff(diff: TextDiff): string {
  const lines: string[] = [`--- a/${diff.path}`, `+++ b/${diff.path}`]
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const row of hunk.lines) {
      const prefix = row.kind === "context" ? " " : row.kind === "add" ? "+" : "-"
      lines.push(prefix + row.text)
      if (row.noNewline) lines.push(NO_NEWLINE_MARKER)
    }
  }
  return lines.join("\n") + "\n"
}
