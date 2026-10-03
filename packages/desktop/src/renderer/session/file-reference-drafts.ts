import { publishDraftChange, isDraftRetired } from "./draft-changes.ts"
const empty: readonly string[] = []
const cache = new Map<string, { raw: string | null; paths: readonly string[] }>()
const fallback = new Map<string, string>()
const volatile = new Set<string>()
const listeners = new Set<() => void>()
const keyFor = (workspace: string, session: string) => `ih:file-references:${JSON.stringify([workspace, session])}`
const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\0\r\n:]/.test(value) && !/^[\\/]/.test(value) && !value.split(/[\\/]/).includes("..")
export function readFileReferences(workspace: string, session: string): readonly string[] {
  const key = keyFor(workspace, session)
  let raw: string | null
  try { raw = volatile.has(key) ? fallback.get(key) ?? null : localStorage.getItem(key) } catch { raw = fallback.get(key) ?? null }
  const old = cache.get(key)
  if (old?.raw === raw) return old.paths
  let paths = empty
  try { const parsed: unknown = JSON.parse(raw ?? "[]"); if (Array.isArray(parsed)) paths = [...new Set(parsed.filter(valid))].slice(0, 8) } catch { /* Invalid local UI metadata is ignored. */ }
  cache.set(key, { raw, paths })
  return paths
}
export function writeFileReferences(workspace: string, session: string, paths: readonly string[], requireRemoval = false): void {
  if (paths.length && isDraftRetired(workspace, session)) return
  if (paths.length > 8 || paths.some((path) => !valid(path))) throw new Error("Invalid workspace file references")
  const key = keyFor(workspace, session), raw = paths.length ? JSON.stringify(paths) : null
  if (raw) fallback.set(key, raw); else fallback.delete(key)
  try { if (raw) localStorage.setItem(key, raw); else localStorage.removeItem(key); volatile.delete(key) } catch (error) { volatile.add(key); if (!raw && requireRemoval) throw error }
  cache.set(key, { raw, paths: paths.length ? [...paths] : empty })
  for (const listener of listeners) listener()
  publishDraftChange(workspace, session)
}
export function subscribeFileReferences(listener: () => void): () => void {
  listeners.add(listener)
  const storage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith("ih:file-references:")) listener() }
  window.addEventListener("storage", storage)
  return () => { listeners.delete(listener); window.removeEventListener("storage", storage) }
}
