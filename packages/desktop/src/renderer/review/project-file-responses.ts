import type { ProjectFilePage, ProjectFileRef, ProjectFileRoot } from "../../../../desktop-gateway/src/project-files.ts"
import type { EditableSource, ReviewSaveResult } from "./SourceFileEditor.tsx"

export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
export const boundedString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max
export const nonnegativeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
export const revisionString = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
export const validWorkspaceId = (value: unknown): value is string => boundedString(value, 256) && value.length > 0 && !/[\0\r\n]/.test(value)
export const validRelativePath = (value: unknown, empty = false): value is string => boundedString(value, 4096) && (empty && value === "" || value.length > 0 && !/[\\\0\r\n:]/.test(value) && !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"))
export function checkedReadFlags(value: Record<string, unknown>): { readonly?: boolean; external?: boolean } {
  if (value.readonly !== undefined && typeof value.readonly !== "boolean" || value.external !== undefined && typeof value.external !== "boolean") throw new Error("Invalid file read permissions")
  return { ...(value.readonly !== undefined || value.external === true ? { readonly: value.readonly === true || value.external === true } : {}), ...(typeof value.external === "boolean" ? { external: value.external } : {}) }
}
export function checkedFileRef(value: unknown): ProjectFileRef {
  if (!record(value) || !validWorkspaceId(value.workspaceId) || !validRelativePath(value.path)) throw new Error("Invalid project file reference")
  return { workspaceId: value.workspaceId, path: value.path }
}
export function checkedProjectRoots(value: unknown): ProjectFileRoot[] {
  if (!record(value) || !Array.isArray(value.roots) || value.roots.length > 1000) throw new Error("Invalid project roots")
  const seen = new Set<string>()
  return value.roots.map(root => {
    if (!record(root) || !validWorkspaceId(root.workspaceId) || !boundedString(root.label, 4096) || seen.has(root.workspaceId)) throw new Error("Invalid project roots")
    seen.add(root.workspaceId)
    return { workspaceId: root.workspaceId, label: root.label }
  })
}
export function checkedFilePage(value: unknown): ProjectFilePage {
  if (!record(value) || !Array.isArray(value.entries) || value.entries.length > 100 || !(value.nextOffset === null || nonnegativeInteger(value.nextOffset)) || typeof value.truncated !== "boolean") throw new Error("Invalid project file list")
  const entries = value.entries.map<ProjectFilePage["entries"][number]>(row => {
    if (!record(row) || !validRelativePath(row.path) || !boundedString(row.name, 4096) || !row.name || (row.kind !== "file" && row.kind !== "directory")) throw new Error("Invalid project file list")
    return { path: row.path, name: row.name, kind: row.kind }
  })
  return { entries, nextOffset: value.nextOffset, truncated: value.truncated }
}
export function checkedEditableSource(value: unknown): EditableSource {
  if (!record(value)) throw new Error("Invalid project file content")
  if (value.kind === "unavailable" && boundedString(value.reason, 1024)) return { kind: "unavailable", reason: value.reason }
  if (value.kind !== "text" || !boundedString(value.text, 1024 * 1024) || typeof value.truncated !== "boolean" || !nonnegativeInteger(value.bytes) || value.bytes > 1024 * 1024 || (value.revision !== undefined && !revisionString(value.revision))) throw new Error("Invalid project file content")
  return { kind: "text", text: value.text, truncated: value.truncated, bytes: value.bytes, ...(value.revision !== undefined ? { revision: value.revision } : {}), ...checkedReadFlags(value) }
}
export function checkedSaveResult(value: unknown): ReviewSaveResult {
  if (!record(value)) throw new Error("Invalid project file save result")
  if (value.kind === "conflict") return { kind: "conflict" }
  if (value.kind === "unavailable" && boundedString(value.reason, 1024)) return { kind: "unavailable", reason: value.reason }
  if (value.kind === "saved" && revisionString(value.revision) && nonnegativeInteger(value.bytes) && value.bytes <= 1024 * 1024) return { kind: "saved", revision: value.revision, bytes: value.bytes }
  throw new Error("Invalid project file save result")
}
