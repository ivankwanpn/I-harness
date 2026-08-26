// Text rendering of LSP query results: grouped locations, hover contents, and
// diagnostics with caps + omission markers, plus a hard character cap.
import type { LspHover, LspQueryResult } from "./instance.ts"

export interface RenderOptions {
  workspaceRoot?: string
  maxLocations?: number    // default 100
  maxResultChars?: number  // default 16000
  maxResults?: number      // default 50 (diagnostics)
}

const SEVERITY_LABELS: Record<number, string> = { 1: "Error", 2: "Warning", 3: "Information", 4: "Hint" }

export function formatLocations(result: Extract<LspQueryResult, { kind: "locations" }>, opts: RenderOptions): string {
  const maxLocations = opts.maxLocations ?? 100
  const maxChars = opts.maxResultChars ?? 16000
  if (result.locations.length === 0) return "No results."
  const shown = result.locations.slice(0, maxLocations)
  const omitted = result.locations.length - shown.length
  const root = opts.workspaceRoot !== undefined ? opts.workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "") : undefined
  // group by file path (insertion order preserved)
  const byFile = new Map<string, string[]>()
  for (const loc of shown) {
    const path = loc.uri.replace(/^file:\/\//, "")
    // slice the workspace-root prefix only for files under it (boundary-safe:
    // exact root and sibling dirs like /w2 under root /w are left as-is)
    const rel = root !== undefined && path.startsWith(root + "/") ? path.slice(root.length + 1) : path
    const line = `${loc.range.start.line + 1}:${loc.range.start.character + 1}-${loc.range.end.line + 1}:${loc.range.end.character + 1}`
    const arr = byFile.get(rel) ?? []
    arr.push(line)
    byFile.set(rel, arr)
  }
  let text = [...byFile.entries()].map(([f, lines]) => `${f}:${lines.join("\n  ")}`).join("\n")
  if (omitted > 0) text += `\n(${omitted} omitted)`
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text
}

export function formatHover(result: Extract<LspQueryResult, { kind: "hover" }>, _opts: RenderOptions): string {
  if (result.hover === null) return "No hover information."
  return (result.hover as LspHover).contents
}

export function formatDiagnostics(diagnostics: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; source?: string }>, opts: RenderOptions): string {
  const maxResults = opts.maxResults ?? 50
  const shown = diagnostics.slice(0, maxResults)
  const omitted = diagnostics.length - shown.length
  let text = shown.map((d) => {
    const sev = d.severity !== undefined ? SEVERITY_LABELS[d.severity] ?? "Unknown" : "Diagnostic"
    return `${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}]${d.source !== undefined ? ` ${d.source}:` : ""} ${d.message}`
  }).join("\n")
  if (omitted > 0) text += `\n(${omitted} more diagnostics)`
  return text || "No diagnostics."
}
