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

/** Strip the `file://` prefix (and any percent-escapes, decoding them) so the
 *  remaining path is usable as a filesystem path for workspace slicing. */
function fileUriToPath(uri: string): string {
  const raw = uri.replace(/^file:\/\//, "")
  // Decode percent-escapes (e.g. %20 → space) from canonical file URIs before
  // workspace comparison; failure to decode is a no-op (best-effort).
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // malformed escape sequence — keep the raw form (fail-closed display)
  }
  // win32 canonical form is file:///C:/... — the leading slash before a drive
  // letter must be dropped so the path can be compared/sliced with the
  // workspace root (C:/ws-style).
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded
}

/** Workspace-relative path (or the raw path when outside the workspace).
 *  Comparison is boundary-safe (exact root and sibling dirs like /w2 under
 *  root /w are left as-is) and drive letters are compared case-insensitively. */
function workspaceRelPath(path: string, root: string | undefined): string {
  if (root === undefined) return path
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "")
  const rootLower = rootNorm.toLowerCase()
  const pathLower = path.toLowerCase()
  if (pathLower.startsWith(rootLower + "/")) return path.slice(rootNorm.length + 1)
  return path
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text
}

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
    const path = workspaceRelPath(fileUriToPath(loc.uri), root)
    const line = `${loc.range.start.line + 1}:${loc.range.start.character + 1}-${loc.range.end.line + 1}:${loc.range.end.character + 1}`
    const arr = byFile.get(path) ?? []
    arr.push(line)
    byFile.set(path, arr)
  }
  let text = [...byFile.entries()].map(([f, lines]) => `${f}:${lines.join("\n  ")}`).join("\n")
  if (omitted > 0) text += `\n(${omitted} omitted)`
  return truncate(text, maxChars)
}

export function formatHover(result: Extract<LspQueryResult, { kind: "hover" }>, opts: RenderOptions): string {
  const maxChars = opts.maxResultChars ?? 16000
  if (result.hover === null) return "No hover information."
  const hover = result.hover as LspHover
  let text = hover.contents
  if (hover.range !== undefined) {
    text += `\n${hover.range.start.line + 1}:${hover.range.start.character + 1}-${hover.range.end.line + 1}:${hover.range.end.character + 1}`
  }
  return truncate(text, maxChars)
}

export function formatDiagnostics(diagnostics: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; source?: string }>, opts: RenderOptions): string {
  const maxResults = opts.maxResults ?? 50
  const maxChars = opts.maxResultChars ?? 16000
  const shown = diagnostics.slice(0, maxResults)
  const omitted = diagnostics.length - shown.length
  let text = shown.map((d) => {
    const sev = d.severity !== undefined ? SEVERITY_LABELS[d.severity] ?? "Unknown" : "Diagnostic"
    return `${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}]${d.source !== undefined ? ` ${d.source}:` : ""} ${d.message}`
  }).join("\n")
  if (omitted > 0) text += `\n(${omitted} more diagnostics)`
  if (text.length === 0) return "No diagnostics."
  return truncate(text, maxChars)
}
