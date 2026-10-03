import { normalizeSearchQuery, createSearchStats, type SearchResult, type SearchQuery } from "../../../fs-search/src/index.ts"
import type { ProjectContentSearchResult, ProjectSearchPreview, ContentSearchLimits } from "../../../desktop-gateway/src/project-content-search.ts"
import { projectRelativePath, type ProjectFileSelection } from "../../../desktop-gateway/src/project-files.ts"
import { resolveCurrentProjectMembers, runtimeForProjectMember } from "./project-membership.ts"
import type { DesktopIpcDependencies } from "./ipc.ts"
import type { WorkspaceRuntime } from "./sdk-runtime.ts"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { referenceAbsolutePath } from "../../../desktop-gateway/src/reference-content.ts"
import type { FileResult } from "../../../desktop-gateway/src/review.ts"

const identifier = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value || value.length > 256 || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${field}`)
  return value
}
function selectionOf(value: Record<string, unknown>): ProjectFileSelection {
  return { workspaceId: identifier(value.workspaceId, "workspaceId"), ...(value.sessionId === undefined ? {} : { sessionId: identifier(value.sessionId, "sessionId") }), ...(value.projectId === undefined ? {} : { projectId: identifier(value.projectId, "projectId") }) }
}
const ownerKey = (selection: ProjectFileSelection) => JSON.stringify([selection.workspaceId, selection.sessionId ?? null, selection.projectId ?? null])
const activeOwners = new Set<ReturnType<typeof createDesktopProjectContentSearch>>()
type NativeOwnedJob = { selection: ProjectFileSelection; selectionKey: string; scope?: { projectId?: string; members: { id: string; path: string }[] }; controller: AbortController; children: { runtime: WorkspaceRuntime; requestId: string }[]; promise: Promise<unknown> }
type NativeSearchJob = Omit<NativeOwnedJob, "promise"> & { promise: Promise<ProjectContentSearchResult> }
const globalLimits = { maxCandidates: 1000, maxInputBytes: 32 * 1024 * 1024, maxFileBytes: 1024 * 1024, maxEngineRawBytes: 1024 * 1024, maxRunnerRawBytes: 1024 * 1024, maxEntries: 3000, maxPolicyFiles: 20, maxCandidateBytes: 256 * 1024 }

function responseOf(value: unknown): SearchResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid content search response")
  const result = value as SearchResult
  if (!["completed", "limited", "cancelled", "timed-out", "error"].includes(result.status) || typeof result.partial !== "boolean" || typeof result.truncated !== "boolean" || !Array.isArray(result.matches) || result.matches.length > 1000 || !Array.isArray(result.reasons) || result.reasons.length > 16 || result.reasons.some(reason => typeof reason !== "string" || reason.length > 512) || !Array.isArray(result.diagnostics) || result.diagnostics.length > 16 || result.diagnostics.some(detail => typeof detail !== "string" || detail.length > 512) || !result.stats || !result.filters || !result.limits || Buffer.byteLength(JSON.stringify(result)) > 256 * 1024) throw new Error("Invalid bounded content search response")
  for (const key of Object.keys(createSearchStats()) as (keyof SearchResult["stats"])[]) if (!Number.isSafeInteger(result.stats[key]) || result.stats[key] < 0) throw new Error("Invalid search statistics")
  for (const row of result.matches) {
    if (isAbsolute(row.path) && row.external === true && row.readonly === true) referenceAbsolutePath(row.path)
    else projectRelativePath(row.path)
    if (!Number.isSafeInteger(row.line) || row.line < 1 || typeof row.text !== "string" || row.column !== undefined && (!Number.isSafeInteger(row.column) || row.column < 0) || row.endLine !== undefined && (!Number.isSafeInteger(row.endLine) || row.endLine < row.line) || row.endColumn !== undefined && (!Number.isSafeInteger(row.endColumn) || row.endColumn < 0) || row.revision !== undefined && !/^[a-f0-9]{64}$/.test(row.revision)) throw new Error("Invalid content match range")
  }
  return result
}
function boundedResult(result: ProjectContentSearchResult, maxBytes: number) {
  const fits = () => Buffer.byteLength(JSON.stringify(result)) <= maxBytes
  if (fits()) return result
  result.partial = true; result.truncated = true; if (result.status === "completed") result.status = "limited"
  if (!result.reasons.includes("result-byte-limit")) result.reasons.push("result-byte-limit")
  while (result.matches.length && !fits()) result.matches.pop()
  while (result.diagnostics.length && !fits()) result.diagnostics.pop()
  if (!fits()) { result.filters.includes = []; result.filters.excludes = []; result.filters.filterPatternsTruncated = true }
  if (!fits() && typeof result.filters.referencePath === "string") { result.filters.referencePath = result.filters.referencePath.slice(0, 512); result.filters.referencePathTruncated = true }
  if (!fits() && result.error) result.error = result.error.slice(0, 128)
  while (result.roots.length && !fits()) result.roots.pop()
  if (!fits()) throw new Error("Content search metadata exceeds the bounded result ceiling")
  return result
}

/** One instance belongs to one trusted native window. Captured runtime handles
 * remain reachable after membership withdrawal, solely to cancel owned work. */
export function createDesktopProjectContentSearch(dependencies: DesktopIpcDependencies) {
  const jobs = new Map<string, NativeSearchJob>()
  const previews = new Map<string, NativeOwnedJob>()
  let closing = false
  let closingPromise: Promise<void> | undefined
  async function stop(job: Pick<NativeSearchJob, "controller" | "children">, reason = "Content search cancelled") {
    job.controller.abort(new Error(reason))
    await Promise.allSettled(job.children.map(child => child.runtime.client.request("desktop/project-files/content-cancel", { requestId: child.requestId })))
  }
  const service = {
    async request(value: Record<string, unknown>): Promise<unknown> {
      const selection = selectionOf(value)
      if (value.kind === "desktop/project-files/content-cancel") {
        const id = identifier(value.requestId, "requestId"), job = jobs.get(id) ?? previews.get(id)
        if (!job) return { cancelled: false }
        if (job.selectionKey !== ownerKey(selection)) throw new Error("Content search cancellation owner mismatch")
        await stop(job); await job.promise.catch(() => {})
        return { cancelled: true }
      }
      if (closing) throw new Error("Native content search is closing")
      if (["desktop/project-files/search-preview", "desktop/project-files/external-preview", "desktop/project-files/external-read"].includes(String(value.kind))) {
        const previewId = value.requestId === undefined ? `viewer:${randomUUID()}` : identifier(value.requestId, "requestId")
        if (jobs.has(previewId) || previews.has(previewId)) throw new Error("Content request ID is already active")
        const preview: NativeOwnedJob = { selection: { ...selection }, selectionKey: ownerKey(selection), controller: new AbortController(), children: [], promise: Promise.resolve(undefined as unknown) }
        previews.set(previewId, preview)
        const timer = setTimeout(() => { void stop(preview) }, 30000); timer.unref?.()
        preview.promise = (async () => {
        const external = value.kind !== "desktop/project-files/search-preview", readOnlyFile = value.kind === "desktop/project-files/external-read"
        const raw = value.ref as Record<string, unknown> | undefined
        if (!external && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new Error("Invalid preview file identity")
        const scope = external ? await resolveCurrentProjectMembers(selection, dependencies) : undefined
        const workspaceId = external ? (scope!.members.find(member => member.id === selection.workspaceId) ?? scope!.members[0])?.id : identifier(raw!.workspaceId, "target workspaceId")
        if (!workspaceId) throw new Error("Reference viewer owner is no longer available")
        const path = external ? referenceAbsolutePath(value.path) : projectRelativePath(raw!.path)
        if (!readOnlyFile && (typeof value.line !== "number" || !Number.isSafeInteger(value.line) || value.line < 1 || value.line > 10000000)) throw new Error("Invalid preview line")
        if (value.expectedRevision !== undefined && (typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision))) throw new Error("Invalid preview revision")
        const query = normalizeSearchQuery({ pattern: "preview", encoding: value.encoding as SearchQuery["encoding"] }, { profile: "human" })
        const { runtime, member, projectId } = await runtimeForProjectMember(selection, workspaceId, dependencies)
        preview.scope = { projectId, members: [{ id: member.id, path: member.path }] }
        preview.controller.signal.throwIfAborted()
        if (!runtime.info.capabilities["desktop-project-content-search"]?.includes("1")) throw new Error("Project content preview unavailable")
        const requestId = `preview:${randomUUID()}`
        preview.children.push({ runtime, requestId })
        const result = await runtime.client.request(String(value.kind), { requestId, path, line: value.line, encoding: query.encoding, expectedRevision: value.expectedRevision }) as ProjectSearchPreview | FileResult
        preview.controller.signal.throwIfAborted()
        const after = await resolveCurrentProjectMembers(selection, dependencies)
        if (after.projectId !== projectId || !after.members.some(row => row.id === member.id && row.path === member.path)) throw new Error("Project folder membership changed")
        if (readOnlyFile) {
          const file = result as FileResult
          if (file?.kind === "unavailable") return file
          if (!file || file.kind !== "text" || file.readonly !== true || file.external !== true || typeof file.text !== "string" || Buffer.byteLength(file.text) > 256 * 1024 || typeof file.truncated !== "boolean") throw new Error("Invalid bounded reference read")
          return file
        }
        const view = result as ProjectSearchPreview
        if (!view || view.readonly !== true || external && view.external !== true || typeof view.text !== "string" || Buffer.byteLength(view.text, "utf8") > 32768 || Buffer.byteLength(view.text, "utf16le") > 32768 || !Number.isSafeInteger(view.startLine) || view.startLine < 1 || typeof view.encoding !== "string" || !/^[a-f0-9]{64}$/.test(view.revision) || typeof view.changedSinceSearch !== "boolean" || typeof view.truncated !== "boolean") throw new Error("Invalid bounded readonly preview")
        return result
        })().catch(async error => { await stop(preview); throw error }).finally(() => { clearTimeout(timer); previews.delete(previewId) })
        return preview.promise
      }
      if (value.kind !== "desktop/project-files/content-search") throw new Error("Invalid native content search request")
      const requestId = identifier(value.requestId, "requestId"), query = normalizeSearchQuery(value.query as SearchQuery, { profile: "human" })
      const referencePath = value.referencePath === undefined ? undefined : referenceAbsolutePath(value.referencePath)
      if (jobs.has(requestId) || previews.has(requestId)) throw new Error("Content search request ID is already active")
      const workspaceIds = value.workspaceIds
      if (referencePath && workspaceIds !== undefined) throw new Error("Reference location and project root subset are mutually exclusive")
      if (workspaceIds !== undefined && (!Array.isArray(workspaceIds) || !workspaceIds.length || workspaceIds.length > 1000 || workspaceIds.some(id => typeof id !== "string" || !id || id.length > 256) || new Set(workspaceIds).size !== workspaceIds.length)) throw new Error("Invalid content root subset")
      const controller = new AbortController(), job: NativeSearchJob = { selection: { ...selection }, selectionKey: ownerKey(selection), controller, children: [], promise: Promise.resolve(undefined as unknown as ProjectContentSearchResult) }
      jobs.set(requestId, job) // Register before membership/startup awaits.
      let timedOut = false
      const deadlineAt = Date.now() + query.timeoutMs, timer = setTimeout(() => { timedOut = true; void stop(job) }, query.timeoutMs); timer.unref?.()
      job.promise = Promise.resolve().then(async () => {
        const result: ProjectContentSearchResult = { matches: [], roots: [], status: "completed", partial: false, truncated: false, reasons: [], diagnostics: [], stats: createSearchStats(), filters: { hidden: query.hidden, respectIgnore: query.respectIgnore, includes: query.includes, excludes: query.excludes, ignorePolicy: "pinned-project-local", fixedExclusions: [".git", "node_modules"], ordering: "root-order/retained-path-line" }, limits: { ...globalLimits, maxResults: query.maxResults, maxResultBytes: query.maxResultBytes, timeoutMs: query.timeoutMs } }
        const remaining = { ...globalLimits }
        const addReason = (reason: string, detail?: string) => { result.partial = true; if (!result.reasons.includes(reason) && result.reasons.length < 16) result.reasons.push(reason); if (detail && result.diagnostics.length < 16) result.diagnostics.push(detail.slice(0, 512)) }
        try {
          controller.signal.throwIfAborted()
          const scope = await resolveCurrentProjectMembers(selection, dependencies)
          controller.signal.throwIfAborted()
          const members = referencePath ? [scope.members.find(member => member.id === selection.workspaceId) ?? scope.members[0]].filter(member => member !== undefined) : workspaceIds === undefined ? scope.members : (workspaceIds as string[]).map(id => { const member = scope.members.find(row => row.id === id); if (!member) throw new Error("Folder is not a current project member"); return member })
          if (!members.length) throw new Error("Search owner is no longer available")
          job.scope = { projectId: scope.projectId, members: members.map(member => ({ id: member.id, path: member.path })) }
          result.roots = referencePath ? [] : members.map(member => ({ workspaceId: member.id, label: member.label }))
          if (referencePath) result.filters = { ...result.filters, referencePath, readonly: true }
          for (let index = 0; index < members.length; index++) {
            controller.signal.throwIfAborted()
            if (result.matches.length >= query.maxResults || remaining.maxCandidates <= 0 || remaining.maxInputBytes <= 0 || remaining.maxEngineRawBytes <= 0 || remaining.maxRunnerRawBytes <= 0 || remaining.maxEntries <= 0 || remaining.maxCandidateBytes <= 0 || remaining.maxPolicyFiles <= 0 && query.respectIgnore) { addReason("aggregate-limit", "Later project roots were not searched"); result.status = "limited"; result.truncated = true; break }
            const current = members[index]!
            const { runtime, member, projectId } = await runtimeForProjectMember(selection, current.id, dependencies)
            controller.signal.throwIfAborted()
            if (member.path !== current.path || projectId !== scope.projectId) throw new Error("Project folder membership changed")
            if (!runtime.info.capabilities["desktop-project-content-search"]?.includes("1")) { addReason("search-unavailable", `${member.label}: content search capability unavailable`); result.status = "error"; continue }
            const subId = `${requestId.slice(0, 210)}:${index}`
            job.children.push({ runtime, requestId: subId })
            let local: SearchResult
            try { local = responseOf(await runtime.client.request("desktop/project-files/content-search", { requestId: subId, query: { ...query, maxResults: query.maxResults - result.matches.length }, limits: remaining satisfies ContentSearchLimits, deadlineAt, ...(referencePath ? { referencePath } : {}) })) }
            catch (error) { await runtime.client.request("desktop/project-files/content-cancel", { requestId: subId }).catch(() => {}); if (controller.signal.aborted) throw error; addReason("root-error", `${member.label}: ${error instanceof Error ? error.message : String(error)}`); result.status = "error"; break }
            const after = await resolveCurrentProjectMembers(selection, dependencies)
            if (after.projectId !== scope.projectId || members.some(expected => !after.members.some(row => row.id === expected.id && row.path === expected.path))) {
              result.matches = result.matches.filter(row => "ref" in row && after.members.some(member => member.id === row.ref.workspaceId))
              throw new Error("Project folder membership changed")
            }
            for (const key of Object.keys(result.stats) as (keyof SearchResult["stats"])[]) result.stats[key] += local.stats[key]
            result.filters = { ...result.filters, ...local.filters, ordering: "root-order/retained-path-line" }
            remaining.maxCandidates -= local.stats.candidateFiles; remaining.maxInputBytes -= local.stats.inputBytes; remaining.maxEngineRawBytes -= local.stats.engineRawBytes; remaining.maxRunnerRawBytes -= local.stats.runnerRawBytes
            remaining.maxEntries -= Number(local.limits.entries ?? 0); remaining.maxPolicyFiles -= Number(local.limits.policyFiles ?? 0); remaining.maxCandidateBytes -= Number(local.limits.candidateBytes ?? 0)
            result.matches.push(...local.matches.map(match => referencePath ? { ...match, reference: { path: referenceAbsolutePath(match.path), readonly: true as const }, readonly: true as const, external: true as const } : { ...match, ref: { workspaceId: member.id, path: match.path } }))
            for (const reason of local.reasons) addReason(reason)
            result.diagnostics.push(...local.diagnostics.map(detail => `${member.label}: ${detail}`).slice(0, 16 - result.diagnostics.length))
            result.partial ||= local.partial; result.truncated ||= local.truncated
            if (local.status !== "completed") result.status = local.status
            if (local.status === "cancelled" || local.status === "timed-out") break
            boundedResult(result, query.maxResultBytes)
            if (result.reasons.includes("result-byte-limit")) break
          }
          const after = await resolveCurrentProjectMembers(selection, dependencies)
          if (after.projectId !== scope.projectId || members.some(member => !after.members.some(row => row.id === member.id && row.path === member.path))) {
            result.matches = result.matches.filter(row => "ref" in row && after.members.some(member => member.id === row.ref.workspaceId)); throw new Error("Project folder membership changed")
          }
        } catch (error) {
          if (controller.signal.aborted) { result.status = timedOut ? "timed-out" : "cancelled"; addReason(timedOut ? "timeout" : "cancelled") }
          else { result.status = "error"; result.error = error instanceof Error ? error.message : String(error); addReason("scope-or-search-error", result.error) }
          await stop(job)
        }
        if (controller.signal.aborted && result.status !== "error") { result.status = timedOut ? "timed-out" : "cancelled"; addReason(timedOut ? "timeout" : "cancelled") }
        if (controller.signal.reason instanceof Error && controller.signal.reason.message.includes("membership changed")) addReason("membership-changed")
        const order = new Map(result.roots.map((root, index) => [root.workspaceId, index]))
        result.matches.sort((first, second) => ("ref" in first ? order.get(first.ref.workspaceId) ?? 0 : 0) - ("ref" in second ? order.get(second.ref.workspaceId) ?? 0 : 0) || first.path.localeCompare(second.path) || first.line - second.line || (first.column ?? 0) - (second.column ?? 0))
        return boundedResult(result, query.maxResultBytes)
      }).finally(() => { clearTimeout(timer); jobs.delete(requestId) })
      return job.promise
    },
    async scopeChanged() {
      await Promise.allSettled([...jobs.values(), ...previews.values()].map(async job => {
        if (!job.scope) return
        let changed = false
        try { const current = await resolveCurrentProjectMembers(job.selection, dependencies); changed = current.projectId !== job.scope.projectId || job.scope.members.some(member => !current.members.some(row => row.id === member.id && row.path === member.path)) }
        catch { changed = true }
        if (changed) { await stop(job, "Project folder membership changed"); await job.promise.catch(() => {}) }
      }))
    },
    close() { return closingPromise ??= (async () => { closing = true; const owned = [...jobs.values(), ...previews.values()]; await Promise.allSettled(owned.map(job => stop(job))); await Promise.allSettled(owned.map(job => job.promise)); activeOwners.delete(service) })() },
  }
  activeOwners.add(service)
  return service
}

export async function closeDesktopProjectContentSearches() { await Promise.allSettled([...activeOwners].map(owner => owner.close())) }
export async function notifyDesktopProjectContentScopesChanged() { await Promise.allSettled([...activeOwners].map(owner => owner.scopeChanged())) }
