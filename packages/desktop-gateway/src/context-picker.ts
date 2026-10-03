import { opendir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionQuery } from "@i-harness/session-query"
import type { WorkspaceReview } from "./review.ts"

export type ContextReference = { kind: "file"; workspaceId: string; path: string } | { kind: "session"; workspaceId: string; sessionId: string; seq: number }
export type ContextItem = ContextReference & { label: string; workspaceLabel?: string; excerpt?: string }
export interface ContextPage { items: ContextItem[]; nextOffset: number | null; truncated?: boolean }
export function contextQuery(value: unknown) {
  const p = value as Record<string, unknown> | undefined
  if (!p || (p.contextKind !== "files" && p.contextKind !== "sessions") || typeof p.query !== "string" || p.query.length > 512 || typeof p.offset !== "number" || !Number.isSafeInteger(p.offset) || p.offset < 0 || p.offset > 10000) throw new Error("Invalid context search")
  return { contextKind: p.contextKind, query: p.query, offset: p.offset }
}
export function contextReference(value: unknown): ContextReference {
  const p = value as Record<string, unknown> | undefined
  if (!p || typeof p.workspaceId !== "string" || !p.workspaceId || p.workspaceId.length > 256) throw new Error("Invalid reference workspace")
  if (p.kind === "file" && typeof p.path === "string" && p.path.length > 0 && p.path.length <= 4096 && !isAbsolute(p.path) && !/^[\\/]|[\0\r\n:]/.test(p.path) && !p.path.split(/[\\/]/).includes("..")) return { kind: "file", workspaceId: p.workspaceId, path: p.path }
  if (p.kind === "session" && typeof p.sessionId === "string" && p.sessionId.length > 0 && p.sessionId.length <= 256 && typeof p.seq === "number" && Number.isSafeInteger(p.seq) && p.seq >= 0) return { kind: "session", workspaceId: p.workspaceId, sessionId: p.sessionId, seq: p.seq }
  throw new Error("Invalid context reference")
}
export function createContextPicker(workspace: string, coordinator: SessionCoordinator, review: WorkspaceReview, options: { visible(id: string, meta: any): Promise<boolean>; projectFor(id: string): Promise<string | undefined>; query?: SessionQuery }) {
  const LIMIT = 100, SCAN = 3000
  async function allowed(id: string, projectId?: string) {
    const { meta } = await coordinator.profile(id)
    if (meta.archived || !await options.visible(id, meta) || await options.projectFor(id) !== projectId) throw new Error("Session reference is outside the current project")
    return meta
  }
  return {
    async search(value: unknown) {
      const q = contextQuery(value), p = value as { projectId?: string }
      const items: Omit<ContextItem, "workspaceId">[] = []
      const needle = q.query.toLocaleLowerCase()
      let scanned = 0, truncated = false
      if (q.contextKind === "files") {
        const root = await realpath(workspace)
        const pathKey = (path: string) => process.platform === "win32" ? path.toLocaleLowerCase() : path
        if (pathKey(root) !== pathKey(resolve(workspace))) throw new Error("Workspace root identity changed")
        async function walk(path: string, depth: number): Promise<void> {
          if (depth > 32 || scanned >= SCAN || items.length >= 10000) { truncated = true; return }
          const actual = await realpath(path), rel = relative(root, actual)
          if (rel.startsWith("..") || isAbsolute(rel)) return
          const rows = []
          for await (const row of await opendir(actual)) {
            if (++scanned > SCAN) { truncated = true; break }
            rows.push(row)
          }
          rows.sort((a, b) => a.name.localeCompare(b.name))
          for (const row of rows) {
            if (row.isSymbolicLink() || [".git", "node_modules"].includes(row.name)) continue
            const child = join(path, row.name), name = relative(root, child).replaceAll("\\", "/")
            let target: string
            try { target = relative(root, await realpath(child)) } catch { continue }
            if (target.startsWith("..") || isAbsolute(target)) continue
            if (row.isDirectory()) await walk(child, depth + 1)
            else if (row.isFile() && name.toLocaleLowerCase().includes(needle)) items.push({ kind: "file", path: name, label: name } as Omit<ContextItem, "workspaceId">)
          }
        }
        await walk(root, 0)
      } else {
        const ids = await coordinator.list()
        for (const id of ids.slice(0, 500)) {
          try {
            const meta = await allowed(id, p.projectId)
            const label = meta.title ?? id
            if (!needle || `${label} ${id}`.toLocaleLowerCase().includes(needle)) items.push({ kind: "session", sessionId: id, seq: 0, label } as Omit<ContextItem, "workspaceId">)
            else if (options.query) {
              const hit = (await options.query.search(q.query, { sessionId: id, limit: 1 }))[0]
              if (hit) items.push({ kind: "session", sessionId: id, seq: hit.seq, label, excerpt: hit.snippet.slice(0, 512) } as Omit<ContextItem, "workspaceId">)
            } else if (coordinator.snapshot) {
              const snapshot = await coordinator.snapshot(id)
              const hit = snapshot.session.events.slice(-100).find((event) => (event.type === "user/message" || event.type === "assistant/message") && event.text.toLocaleLowerCase().includes(needle))
              if (hit && typeof hit.seq === "number") items.push({ kind: "session", sessionId: id, seq: hit.seq, label, excerpt: "text" in hit ? String(hit.text).slice(0, 512) : "" } as Omit<ContextItem, "workspaceId">)
            }
          } catch { /* Hidden/removed/nonmember sessions contribute no content. */ }
        }
        truncated = ids.length > 500
      }
      return { items: items.slice(q.offset, q.offset + LIMIT), total: items.length, truncated }
    },
    async read(value: unknown) {
      const p = value as { reference: unknown; projectId?: string }, ref = contextReference(p.reference)
      if (ref.kind === "file") {
        const result = await review.file(ref.path, 16384)
        if (result.kind !== "text") throw new Error(`Cannot reference file: ${result.reason}`)
        return { text: result.text, truncated: result.truncated }
      }
      await allowed(ref.sessionId, p.projectId)
      if (!coordinator.snapshot) throw new Error("Read-only session snapshots unavailable")
      const snapshot = await coordinator.snapshot(ref.sessionId)
      if (!snapshot.session.events.some((event) => event.seq === ref.seq) && snapshot.session.events.length > 0) throw new Error("Session reference sequence is unavailable")
      const events = snapshot.session.events.filter((event) => typeof event.seq === "number" && event.seq >= Math.max(0, ref.seq - 10) && event.seq <= ref.seq + 10 && (event.type === "user/message" || event.type === "assistant/message")).slice(0, 20).map((event) => ({ type: event.type, seq: event.seq, text: "text" in event ? String(event.text).slice(0, 8192) : "" }))
      const full = JSON.stringify(events)
      return { text: full.slice(0, 16384), truncated: full.length > 16384 || events.some((event) => event.text.length >= 8192) }
    },
  }
}
