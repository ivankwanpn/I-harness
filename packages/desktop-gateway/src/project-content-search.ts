import { normalizeSearchQuery, createSearchStats, resolveRgPath, type SearchQuery, type SearchResult } from "@i-harness/fs-search"
import { decodeSearchText, runByteSearch } from "@i-harness/fs-search/engine"
import { createPinnedProjectContentReader, contentDiagnostic, type ProjectContentBudget, type ProjectContentReaderOptions } from "./project-content-reader.ts"
import { projectRelativePath, type ProjectFileRef, type ProjectFileRoot } from "./project-files.ts"
import { realpath, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { readPinnedReference, referenceAbsolutePath, externalUtf8Result } from "./reference-content.ts"
import type { FileResult } from "./review.ts"

export interface ProjectContentSearchResult extends Omit<SearchResult, "matches"> {
  matches: (SearchResult["matches"][number] & ({ ref: ProjectFileRef } | { reference: { path: string; readonly: true }; readonly: true; external: true }))[]
  roots: ProjectFileRoot[]
}
export interface ProjectSearchPreview {
  readonly: true; text: string; startLine: number; encoding: string; revision: string
  changedSinceSearch: boolean; truncated: boolean; reason?: string; external?: boolean
}
export interface ContentSearchLimits {
  maxCandidates?: number; maxInputBytes?: number; maxFileBytes?: number; maxEngineRawBytes?: number; maxRunnerRawBytes?: number
  maxEntries?: number; maxPolicyFiles?: number; maxCandidateBytes?: number
}
const ceilings: Required<ContentSearchLimits> = { maxCandidates: 1000, maxInputBytes: 32 * 1024 * 1024, maxFileBytes: 1024 * 1024, maxEngineRawBytes: 1024 * 1024, maxRunnerRawBytes: 1024 * 1024, maxEntries: 3000, maxPolicyFiles: 20, maxCandidateBytes: 256 * 1024 }
function identity(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 256 || /[\0\r\n]/.test(value)) throw new Error("Invalid content search request ID")
  return value
}
export function contentSearchLimits(value: unknown): Required<ContentSearchLimits> {
  if (value === undefined) return { ...ceilings }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid content search limits")
  const result = { ...ceilings }
  for (const [key, field] of Object.entries(value)) {
    if (!(key in ceilings) || typeof field !== "number" || !Number.isSafeInteger(field) || field < 1 || field > ceilings[key as keyof ContentSearchLimits]) throw new Error("Invalid content search limit")
    result[key as keyof ContentSearchLimits] = field
  }
  return result
}
export function limitContentResult<T extends SearchResult | ProjectContentSearchResult>(result: T, maxBytes: number): T {
  const fits = () => Buffer.byteLength(JSON.stringify(result)) <= maxBytes
  if (fits()) return result
  result.partial = true; result.truncated = true
  if (result.status === "completed") result.status = "limited"
  if (!result.reasons.includes("result-byte-limit")) result.reasons.push("result-byte-limit")
  while (result.matches.length && !fits()) result.matches.pop()
  while (result.diagnostics.length && !fits()) result.diagnostics.pop()
  if (!fits()) { result.filters.includes = []; result.filters.excludes = []; result.filters.filterPatternsTruncated = true }
  if (!fits() && typeof result.filters.referencePath === "string") { result.filters.referencePath = result.filters.referencePath.slice(0, 512); result.filters.referencePathTruncated = true }
  if (!fits() && result.error) result.error = result.error.slice(0, 128)
  // Root labels are presentation data. Keep only the bounded current-root list.
  if ("roots" in result) while (result.roots.length && !fits()) result.roots.pop()
  if (!fits()) throw new Error("Content result metadata exceeds its bounded ceiling")
  return result
}

/** This service has explicit human project-reader authority. The fixed engine
 * only consumes these checked byte snapshots; it never receives filesystem argv. */
export function createProjectContentSearch(workspace: string, options: ProjectContentReaderOptions = {}) {
  const jobs = new Map<string, { controller: AbortController; promise: Promise<SearchResult> }>()
  const previews = new Map<string, { controller: AbortController; promise: Promise<ProjectSearchPreview | FileResult> }>()
  let previewId = 0
  let closing = false
  async function execute(query: Required<SearchQuery>, signal: AbortSignal, limits: Required<ContentSearchLimits>, timedOut: () => boolean, referencePath?: string): Promise<SearchResult> {
    const stats = createSearchStats()
    const budget: ProjectContentBudget = { maxCandidates: limits.maxCandidates, maxInputBytes: limits.maxInputBytes, maxFileBytes: limits.maxFileBytes, stats, reserved: 0, entries: 0, pathBytes: 0, policyFiles: 0, reasons: new Set(), diagnostics: [], maxEntries: limits.maxEntries, maxPolicyFiles: limits.maxPolicyFiles, maxCandidateBytes: limits.maxCandidateBytes }
    let reader: Awaited<ReturnType<typeof createPinnedProjectContentReader>> | undefined
    let result: SearchResult | undefined
    try {
      signal.throwIfAborted()
      let referenceRoot: string | undefined, explicitFile: string | undefined
      if (referencePath) {
        const resolved = await realpath(referencePath), info = await stat(resolved)
        if (!info.isFile() && !info.isDirectory()) throw new Error("Reference location is not a regular file or folder")
        referenceRoot = info.isFile() ? dirname(resolved) : resolved; explicitFile = info.isFile() ? basename(resolved) : undefined
      }
      reader = await createPinnedProjectContentReader(referenceRoot ?? workspace, budget, signal, options)
      if (referenceRoot) budget.labelRoot = referenceRoot
      const candidates = explicitFile ? [explicitFile] : await reader.candidates(query)
      if (explicitFile) { stats.candidateFiles = 1; budget.pathBytes = Buffer.byteLength(join(referenceRoot!, explicitFile)) }
      const externalPaths = new Set<string>(), captured = reader
      async function* snapshots() {
        for await (const snapshot of captured.snapshots(candidates)) {
          const path = referenceRoot ? join(referenceRoot, snapshot.path) : snapshot.path
          if (!referenceRoot && snapshot.external) externalPaths.add(path)
          yield { ...snapshot, path }
        }
      }
      const { maxCandidates, maxInputBytes, maxFileBytes, maxEngineRawBytes, maxRunnerRawBytes } = limits
      result = await runByteSearch({ query, rgPath: await resolveRgPath(), files: snapshots(), signal, limits: { maxCandidates, maxInputBytes, maxFileBytes, maxEngineRawBytes, maxRunnerRawBytes }, stats })
      result.matches = result.matches.map(match => referenceRoot || externalPaths.has(match.path) ? { ...match, readonly: true, external: true } : match)
      await reader.checkRoot()
    } catch (error) {
      const aborted = signal.aborted
      contentDiagnostic(budget, aborted ? timedOut() ? "timeout" : "cancelled" : "search-unavailable", error instanceof Error ? error.message : String(error))
      result ??= { matches: [], status: aborted ? timedOut() ? "timed-out" : "cancelled" : "error", partial: true, truncated: false, reasons: [], diagnostics: [], stats, filters: {}, limits: {} }
      if (!aborted) { result.matches = []; result.error = error instanceof Error ? error.message : String(error); result.status = "error" }
    } finally { await reader?.close() }
    if (signal.aborted) { result.status = timedOut() ? "timed-out" : "cancelled"; result.partial = true; budget.reasons.add(timedOut() ? "timeout" : "cancelled") }
    result.stats = stats
    result.reasons = [...new Set([...result.reasons, ...budget.reasons])].slice(0, 16)
    result.diagnostics = [...result.diagnostics, ...budget.diagnostics].slice(0, 16).map(detail => detail.slice(0, 512))
    if (result.reasons.length) { result.partial = true; if (result.status === "completed") result.status = "limited" }
    result.truncated ||= result.reasons.some(reason => reason.includes("limit") || reason.includes("incomplete"))
    result.filters = { ...result.filters, hidden: query.hidden, respectIgnore: query.respectIgnore, ignorePolicy: "pinned-project-local", ignoreFiles: [".gitignore", ".ignore", ".rgignore"], ignorePrecedence: ".rgignore > .ignore > .gitignore; deeper rules last; ignored parents not traversed", excludes: query.excludes, includes: query.includes, fixedExclusions: [".git", "node_modules"], ordering: "directory-discovery/parallel-arrival", ...(referencePath ? { referencePath, readonly: true } : {}) }
    result.limits = { ...result.limits, ...limits, timeoutMs: query.timeoutMs, maxResults: query.maxResults, maxResultBytes: query.maxResultBytes, entries: budget.entries, policyFiles: budget.policyFiles, candidateBytes: budget.pathBytes }
    return limitContentResult(result, query.maxResultBytes)
  }
  return {
    search(value: { requestId?: unknown; query?: unknown; limits?: unknown; deadlineAt?: unknown; referencePath?: unknown }): Promise<SearchResult> {
      if (closing) return Promise.reject(new Error("Project content search is closing"))
      const requestId = identity(value.requestId), query = normalizeSearchQuery(value.query as SearchQuery, { profile: "human" }), limits = contentSearchLimits(value.limits)
      const referencePath = value.referencePath === undefined ? undefined : referenceAbsolutePath(value.referencePath)
      if (jobs.has(requestId)) throw new Error("Content search request ID is already active")
      const remaining = value.deadlineAt === undefined ? query.timeoutMs : typeof value.deadlineAt === "number" && Number.isFinite(value.deadlineAt) ? Math.min(query.timeoutMs, value.deadlineAt - Date.now()) : NaN
      if (!Number.isFinite(remaining) || remaining > 30000) throw new Error("Invalid content search deadline")
      const controller = new AbortController(); let timedOut = false
      const timer = setTimeout(() => { timedOut = true; controller.abort(new Error("Content search timed out")) }, Math.max(1, remaining)); timer.unref?.()
      const job = { controller, promise: Promise.resolve(undefined as unknown as SearchResult) }
      jobs.set(requestId, job)
      if (remaining <= 0) { timedOut = true; controller.abort(new Error("Content search timed out")) }
      job.promise = Promise.resolve().then(() => execute(query, controller.signal, limits, () => timedOut, referencePath)).finally(() => { clearTimeout(timer); jobs.delete(requestId) })
      return job.promise
    },
    async cancel(requestId: unknown) {
      const id = identity(requestId), job = jobs.get(id) ?? previews.get(id)
      if (!job) return { cancelled: false }
      job.controller.abort(new Error("Content search cancelled")); await job.promise.catch(() => {})
      return { cancelled: true }
    },
    preview(value: { path?: unknown; line?: unknown; encoding?: unknown; expectedRevision?: unknown; requestId?: unknown; external?: boolean }): Promise<ProjectSearchPreview> {
      if (closing) throw new Error("Project content search is closing")
      const path = value.external ? referenceAbsolutePath(value.path) : projectRelativePath(value.path)
      if (typeof value.line !== "number" || !Number.isSafeInteger(value.line) || value.line < 1 || value.line > 10000000) throw new Error("Invalid search preview line")
      const line = value.line, query = normalizeSearchQuery({ pattern: "preview", encoding: value.encoding as SearchQuery["encoding"] }, { profile: "human" })
      if (value.expectedRevision !== undefined && (typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision))) throw new Error("Invalid search snapshot revision")
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error("Search preview timed out")), 30000); timer.unref?.()
      const requestId = value.requestId === undefined ? `preview:${++previewId}` : identity(value.requestId)
      if (previews.has(requestId) || jobs.has(requestId)) { clearTimeout(timer); throw new Error("Search preview request ID is already active") }
      const job = { controller, promise: Promise.resolve(undefined as unknown as ProjectSearchPreview) }
      previews.set(requestId, job)
      const budget: ProjectContentBudget = { maxCandidates: 1, maxInputBytes: 1024 * 1024, maxFileBytes: 1024 * 1024, stats: createSearchStats(), reserved: 0, entries: 0, pathBytes: 0, policyFiles: 0, reasons: new Set(), diagnostics: [] }
      job.promise = (async () => {
      let reader: Awaited<ReturnType<typeof createPinnedProjectContentReader>> | undefined
      try {
        if (!value.external) reader = await createPinnedProjectContentReader(workspace, budget, controller.signal, options)
        const snapshot = value.external ? await readPinnedReference(path, 1024 * 1024, controller.signal, options) : await reader!.read(path, 1024 * 1024)
        if (!snapshot) throw new Error(budget.diagnostics[0] ?? "Search preview is unavailable")
        const decoded = decodeSearchText(snapshot.bytes, query.encoding), lines = decoded.text.split("\n"), target = Math.min(line - 1, lines.length - 1)
        let encodingWarning: string | undefined
        const strictEncoding = ({ utf8: "utf-8", utf16le: "utf-16le", utf16be: "utf-16be", windows1252: "windows-1252" } as Record<string, string>)[decoded.encoding]
        if (strictEncoding) {
          try { new TextDecoder(strictEncoding, { fatal: true }).decode(snapshot.bytes) }
          catch { encodingWarning = `Invalid or incomplete ${decoded.encoding} bytes in the captured prefix; replacement characters are shown` }
        }
        let start = target, end = target + 1, text = lines[target]!
        const fits = (candidate: string) => Buffer.byteLength(candidate, "utf8") <= 32768 && Buffer.byteLength(candidate, "utf16le") <= 32768
        let cropped = false
        if (!fits(text)) { text = text.slice(0, 16384); cropped = true }
        while (!fits(text)) { text = text.slice(0, Math.max(0, text.length - 512)); cropped = true }
        if (text.length && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
        for (let context = 0; context < 20; context++) {
          if (start > 0 && fits(`${lines[start - 1]}\n${text}`)) { text = `${lines[--start]}\n${text}` }
          if (end < lines.length && fits(`${text}\n${lines[end]}`)) text += `\n${lines[end++]}`
        }
        await reader?.checkRoot()
        const truncated = !snapshot.eof || cropped || start > 0 || end < lines.length || line > lines.length
        const reason = [encodingWarning, ...(truncated ? [line > lines.length ? "Requested line lies beyond the captured prefix" : "Bounded search preview window"] : [])].filter(Boolean).join("; ")
        return { readonly: true, text, startLine: start + 1, encoding: decoded.encoding, revision: snapshot.revision, changedSinceSearch: value.expectedRevision !== undefined && value.expectedRevision !== snapshot.revision, truncated, ...(snapshot.external ? { external: true } : {}), ...(reason ? { reason } : {}) }
      } finally { clearTimeout(timer); await reader?.close(); previews.delete(requestId) }
      })()
      return job.promise
    },
    externalRead(value: { path?: unknown; requestId?: unknown }): Promise<FileResult> {
      if (closing) throw new Error("Project content search is closing")
      const path = referenceAbsolutePath(value.path), requestId = identity(value.requestId), controller = new AbortController()
      if (previews.has(requestId) || jobs.has(requestId)) throw new Error("Reference read request ID is already active")
      const job = { controller, promise: Promise.resolve(undefined as unknown as FileResult) }
      previews.set(requestId, job)
      const timer = setTimeout(() => controller.abort(new Error("Reference read timed out")), 30000); timer.unref?.()
      job.promise = readPinnedReference(path, 256 * 1024, controller.signal, options).then(externalUtf8Result).finally(() => { clearTimeout(timer); previews.delete(requestId) })
      return job.promise
    },
    async close() { closing = true; const owned = [...jobs.values(), ...previews.values()]; for (const job of owned) job.controller.abort(new Error("Project content search closed")); await Promise.allSettled(owned.map(job => job.promise)) },
  }
}

export async function dispatchGatewayContentSearch(method: string, value: unknown, service: ReturnType<typeof createProjectContentSearch>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project content parameters")
  const params = value as Record<string, unknown>
  if (method === "desktop/project-files/content-search") return service.search(params)
  if (method === "desktop/project-files/content-cancel") return service.cancel(params.requestId)
  if (method === "desktop/project-files/search-preview") return service.preview(params)
  if (method === "desktop/project-files/external-preview") return service.preview({ ...params, external: true })
  if (method === "desktop/project-files/external-read") return service.externalRead(params)
  throw new Error("Invalid project content request")
}
