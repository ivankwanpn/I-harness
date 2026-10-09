/* SPDX-License-Identifier: MIT
 * Exact-name family summaries informed by OpenCode 1.18.30 message-part.tsx
 * and DSH 0.2.0-rc.2 GenericToolCard. IH records remain the sole state source.
 * See TOOL_OUTPUT_SOURCES.md.
 */
import type { TextDiff } from "../../../../text-diff/src/index.ts"

export type ToolFamily = "command" | "read" | "write" | "search" | "web" | "code" | "mcp" | "other"
export type ToolState = "pending" | "dispatched" | "received" | "running" | "failed" | "cancelled" | "stopped" | "interrupted"
export const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
export function stringField(value: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof value?.[key] === "string") return value[key]
  return undefined
}
export function toolFamily(name: string): ToolFamily {
  if (["bash", "pwsh", "shell", "exec_command", "run_command"].includes(name)) return "command"
  if (["read", "read_file", "read_image", "list_dir"].includes(name)) return "read"
  if (["write", "write_file", "edit", "apply_patch"].includes(name)) return "write"
  if (["grep", "glob", "code_context_search", "tool_search", "code_search", "search_code", "context_search"].includes(name)) return "search"
  if (["webfetch", "websearch"].includes(name)) return "web"
  if (["code_exec", "code_wait", "code_status"].includes(name)) return "code"
  if (name.startsWith("mcp__") || name.startsWith("list_mcp_resources") || name.startsWith("read_mcp_resource")) return "mcp"
  return "other"
}
export function toolSummary(name: string, args: unknown, output: unknown): string | undefined {
  const input = record(args), result = record(output), family = toolFamily(name)
  const summary = family === "command" ? (typeof args === "string" ? args : stringField(input, ["command", "cmd"]))
    : family === "read" || family === "write" ? stringField(input, ["path", "file_path", "filePath"])
      : family === "search" ? stringField(input, ["pattern", "query"])
        : family === "web" ? stringField(input, ["query", "url"])
          : family === "code" ? stringField(result, ["cellId", "cell_id"]) ?? stringField(input, ["cell_id"])
            : undefined
  return summary?.slice(0, 240)
}
/** A dispatch marker precedes execution; it can never establish running. */
export function toolState(name: string, output: unknown, resultReceived?: true, isError?: true, dispatched?: true): ToolState {
  const row = record(output)
  if (row?.status === "cancelled" || row?.cancelled === true) return "cancelled"
  if (row?.status === "terminated" || row?.status === "killed") return "stopped"
  if (row?.status === "interrupted") return "interrupted"
  const error = row?.error
  if (isError || row?.isError === true || row?.ok === false || (error !== undefined && error !== null && error !== "" && error !== false)
    || (typeof row?.exitCode === "number" && row.exitCode !== 0) || row?.timedOut === true || row?.status === "failed" || row?.status === "error" || row?.status === "timed-out") return "failed"
  if (toolFamily(name) === "code" && row?.status === "running") return "running"
  return resultReceived || output !== undefined ? "received" : dispatched ? "dispatched" : "pending"
}
export function formatRecordedValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return "undefined"
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
export function isRecordedDiff(value: unknown): value is TextDiff {
  const diff = record(value)
  return !!diff && typeof diff.path === "string" && integer(diff.added) && integer(diff.deleted) && typeof diff.truncated === "boolean"
    && Array.isArray(diff.hunks) && diff.hunks.every(value => {
      const hunk = record(value)
      return !!hunk && [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(integer) && Array.isArray(hunk.lines)
        && hunk.lines.every(value => { const line = record(value); return !!line && ["context", "add", "delete"].includes(String(line.kind)) && typeof line.text === "string" && (line.noNewline === undefined || typeof line.noNewline === "boolean") })
    })
}
/** Aggregate aliases repeat per-file changes. Render each recorded copy once. */
export function recordedDiffs(output: unknown): TextDiff[] {
  const row = record(output)
  if (!row) return []
  const aggregate = [row.change, ...(Array.isArray(row.changes) ? row.changes : [])].filter(isRecordedDiff)
  const paths = new Set(aggregate.map(diff => diff.path))
  const applied = (Array.isArray(row.applied) ? row.applied : []).map(entry => record(entry)?.change).filter(isRecordedDiff).filter(diff => !paths.has(diff.path))
  return [...aggregate, ...applied]
}
/** Only recorded hunks are rendered; there is no filesystem or Git lookup. */
export function recordedUnifiedDiff(diff: TextDiff): string {
  const lines = [`--- a/${diff.path}`, `+++ b/${diff.path}`]
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      lines.push(`${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}${line.text}`)
      if (line.noNewline) lines.push("\\ No newline at end of file")
    }
  }
  return lines.join("\n") + "\n"
}
export function safeRecordedUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? value : undefined } catch { return undefined }
}

export type ToolImage = { mediaType: string; dataBase64: string; name?: string; width?: number; height?: number }
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
export function resultImages(output: unknown): ToolImage[] {
  const value = record(output)
  const direct = Array.isArray(value?.images) ? value.images : []
  const content = Array.isArray(output) ? output : Array.isArray(value?.content) ? value.content : []
  const mcp = content.flatMap(item => { const row = record(item); return row?.type === "image" ? [{ mediaType: row.mimeType, dataBase64: row.data, name: row.name }] : [] })
  return [...direct, ...mcp].filter((item): item is ToolImage => !!record(item) && typeof item.mediaType === "string" && imageTypes.has(item.mediaType) && typeof item.dataBase64 === "string")
}
