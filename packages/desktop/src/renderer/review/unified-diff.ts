export interface DiffLine { line: string; kind: "added" | "removed" | "context"; oldLine?: number; newLine?: number }
/** Derives only numbers explicitly anchored by a standard unified hunk header. */
export function parseUnifiedDiff(text: string): DiffLine[] {
  let oldLine = 0; let newLine = 0; let oldRemaining = 0; let newRemaining = 0
  return text.split(/\r?\n/).map((line) => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]); oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1)
      return { line, kind: "context" }
    }
    if (line.startsWith("diff --git ") || line.startsWith("@@")) { oldRemaining = 0; newRemaining = 0 }
    if (line.startsWith("+") && newRemaining > 0) { newRemaining--; return { line, kind: "added", newLine: newLine++ } }
    if (line.startsWith("-") && oldRemaining > 0) { oldRemaining--; return { line, kind: "removed", oldLine: oldLine++ } }
    if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) { oldRemaining--; newRemaining--; return { line, kind: "context", oldLine: oldLine++, newLine: newLine++ } }
    return { line, kind: "context" }
  })
}
