import type { SearchMatch, SearchQuery, SearchResult } from "../../../../fs-search/src/search-types.ts"
import type { ProjectFileRef, ProjectFileRoot } from "../../../../desktop-gateway/src/project-files.ts"
import { absoluteReferencePath, type ExternalFileTarget } from "../session/file-navigation.ts"
import { boundedString, checkedFileRef, checkedProjectRoots, checkedReadFlags, nonnegativeInteger, record, revisionString } from "./project-file-responses.ts"

export type SearchEncoding = NonNullable<SearchQuery["encoding"]>
export interface ProjectContentSearchMatch extends SearchMatch { ref: ProjectFileRef; reference?: undefined; encoding?: SearchEncoding; readonly?: boolean; external?: boolean }
export interface ReferenceContentSearchMatch extends SearchMatch { ref?: undefined; reference: ExternalFileTarget["reference"]; encoding?: SearchEncoding; readonly: true; external: true }
export type ContentSearchMatch = ProjectContentSearchMatch | ReferenceContentSearchMatch
export const projectContentMatch = (match: ContentSearchMatch): match is ProjectContentSearchMatch => match.ref !== undefined
export const referenceContentMatch = (match: ContentSearchMatch): match is ReferenceContentSearchMatch => match.reference !== undefined
export interface ContentSearchResult extends SearchResult { matches: ContentSearchMatch[]; roots: ProjectFileRoot[] }
export interface SearchPreview { readonly: true; external?: boolean; text: string; startLine: number; encoding: SearchEncoding; revision: string; changedSinceSearch: boolean; truncated: boolean; reason?: string }
const encodings: readonly SearchEncoding[] = ["auto", "utf8", "utf16le", "utf16be", "windows1252", "latin1"]
export const isSearchEncoding = (value: unknown): value is SearchEncoding => encodings.some(encoding => encoding === value)
export const utf8Encoding = (encoding?: string) => encoding === undefined || encoding === "auto" || encoding === "utf8"
const positiveInteger = (value: unknown): value is number => nonnegativeInteger(value) && value > 0 && value <= 10000000
function strings(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > 16 || !value.every(item => boundedString(item, maxLength))) throw new Error("Invalid content search diagnostics")
  return [...value]
}
function metadata(value: unknown): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length > 64) throw new Error("Invalid content search metadata")
  // These fields are display data only. Copy bounded JSON; they never select a
  // root, path, reader or navigation target.
  for (const item of Object.values(value)) {
    if (!(item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item) || boundedString(item, 4096) || Array.isArray(item) && item.length <= 32 && item.every(row => boundedString(row, 512)))) throw new Error("Invalid content search metadata")
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Array.isArray(item) ? [...item] : item]))
}
function checkMatch(value: unknown, rootIds: Set<string>): ContentSearchMatch {
  if (!record(value)) throw new Error("Invalid content search match")
  let identity: { ref: ProjectFileRef; reference?: undefined } | { ref?: undefined; reference: ExternalFileTarget["reference"]; readonly: true; external: true }
  if (value.reference !== undefined) {
    if (!record(value.reference) || !absoluteReferencePath(value.reference.path) || value.reference.readonly !== true || value.readonly !== true || value.external !== true || value.ref !== undefined) throw new Error("Invalid readonly reference match")
    identity = { reference: { path: value.reference.path, readonly: true }, readonly: true, external: true }
  } else {
    const ref = checkedFileRef(value.ref)
    if (!rootIds.has(ref.workspaceId) || value.path !== ref.path) throw new Error("Invalid content search match")
    identity = { ref }
  }
  if (!boundedString(value.path, 4096) || !value.path.length || /[\0\r\n]/.test(value.path) || !positiveInteger(value.line) || !boundedString(value.text, 256 * 1024) || value.textTruncated !== undefined && typeof value.textTruncated !== "boolean") throw new Error("Invalid content search match")
  for (const field of ["column", "endColumn"] as const) if (value[field] !== undefined && !nonnegativeInteger(value[field])) throw new Error("Invalid content search range")
  if (value.endLine !== undefined && (!positiveInteger(value.endLine) || value.endLine < value.line)) throw new Error("Invalid content search range")
  if ((value.endLine ?? value.line) === value.line && typeof value.column === "number" && typeof value.endColumn === "number" && value.endColumn < value.column) throw new Error("Invalid content search range")
  if (value.revision !== undefined && !revisionString(value.revision) || value.encoding !== undefined && !isSearchEncoding(value.encoding)) throw new Error("Invalid content search snapshot")
  const context = value.context === undefined ? undefined : (() => {
    if (!Array.isArray(value.context) || value.context.length > 20) throw new Error("Invalid content search context")
    return value.context.map(line => {
      if (!record(line) || !positiveInteger(line.line) || !boundedString(line.text, 256 * 1024) || line.textTruncated !== undefined && typeof line.textTruncated !== "boolean") throw new Error("Invalid content search context")
      return { line: line.line, text: line.text, ...(line.textTruncated !== undefined ? { textTruncated: line.textTruncated } : {}) }
    })
  })()
  return { path: value.path, line: value.line, text: value.text, ...checkedReadFlags(value), ...identity,
    ...(value.textTruncated !== undefined ? { textTruncated: value.textTruncated } : {}),
    ...(value.column !== undefined ? { column: value.column as number } : {}), ...(value.endColumn !== undefined ? { endColumn: value.endColumn as number } : {}), ...(value.endLine !== undefined ? { endLine: value.endLine as number } : {}),
    ...(value.revision !== undefined ? { revision: value.revision as string } : {}), ...(isSearchEncoding(value.encoding) ? { encoding: value.encoding } : {}), ...(context ? { context } : {}) }
}
export function checkedContentSearchResult(value: unknown): ContentSearchResult {
  if (!record(value) || new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) throw new Error("Invalid or oversized content search result")
  if (!["completed", "limited", "cancelled", "timed-out", "error"].includes(String(value.status)) || typeof value.partial !== "boolean" || typeof value.truncated !== "boolean" || !Array.isArray(value.matches) || value.matches.length > 1000 || value.error !== undefined && !boundedString(value.error, 2048)) throw new Error("Invalid content search result")
  const roots = checkedProjectRoots(value), rootIds = new Set(roots.map(root => root.workspaceId))
  if (!record(value.stats)) throw new Error("Invalid content search statistics")
  const sourceStats = value.stats
  const count = (key: keyof SearchResult["stats"]) => {
    const count = sourceStats[key], ceiling = key === "inputBytes" ? 32 * 1024 * 1024 : key === "engineRawBytes" || key === "runnerRawBytes" ? 1024 * 1024 : 1000
    if (!nonnegativeInteger(count) || count > ceiling) throw new Error("Invalid content search statistics")
    return count
  }
  const stats: SearchResult["stats"] = { candidateFiles: count("candidateFiles"), attemptedFiles: count("attemptedFiles"), readFiles: count("readFiles"), completedFiles: count("completedFiles"), eofFiles: count("eofFiles"), inputBytes: count("inputBytes"), engineRawBytes: count("engineRawBytes"), runnerRawBytes: count("runnerRawBytes") }
  const limits = metadata(value.limits)
  if (!Object.values(limits).every(nonnegativeInteger)) throw new Error("Invalid content search limits")
  return { roots, matches: value.matches.map(match => checkMatch(match, rootIds)), status: value.status as SearchResult["status"], partial: value.partial, truncated: value.truncated, reasons: strings(value.reasons, 1024), diagnostics: strings(value.diagnostics, 2048), stats, filters: metadata(value.filters), limits: limits as Record<string, number>, ...(value.error !== undefined ? { error: value.error as string } : {}) }
}
export function checkedSearchCancel(value: unknown): boolean {
  if (!record(value) || typeof value.cancelled !== "boolean") throw new Error("Invalid content search cancellation result")
  return value.cancelled
}
export function checkedSearchPreview(value: unknown): SearchPreview {
  if (!record(value) || value.readonly !== true || !boundedString(value.text, 16 * 1024) || new TextEncoder().encode(value.text).byteLength > 32 * 1024 || !positiveInteger(value.startLine) || !isSearchEncoding(value.encoding) || !revisionString(value.revision) || typeof value.changedSinceSearch !== "boolean" || typeof value.truncated !== "boolean" || value.reason !== undefined && !boundedString(value.reason, 1024)) throw new Error("Invalid search preview")
  return { ...checkedReadFlags(value), readonly: true, text: value.text, startLine: value.startLine, encoding: value.encoding, revision: value.revision, changedSinceSearch: value.changedSinceSearch, truncated: value.truncated, ...(value.reason !== undefined ? { reason: value.reason } : {}) }
}
