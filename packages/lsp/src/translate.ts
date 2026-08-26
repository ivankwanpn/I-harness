// Normalization seam: raw LSP wire payloads → the package's Lsp types.
// Pure functions (no instance/connection coupling). instance.ts keeps its own
// inline wire conversion; these helpers are for tools that receive raw payloads.
import type { LspHover, LspLocation, LspPosition } from "./instance.ts"

function isPosition(v: unknown): v is LspPosition {
  if (typeof v !== "object" || v === null) return false
  const p = v as Record<string, unknown>
  return typeof p.line === "number" && typeof p.character === "number"
}

function isLocation(v: unknown): v is LspLocation {
  if (typeof v !== "object" || v === null) return false
  const l = v as Record<string, unknown>
  if (typeof l.uri !== "string") return false
  if (typeof l.range !== "object" || l.range === null) return false
  const r = l.range as Record<string, unknown>
  return isPosition(r.start) && isPosition(r.end)
}

/** LSP wire shapes: null → []; plain array of {uri, range} → LspLocation[];
 *  { locations: [...] } → its locations; anything else → [] (fail-closed,
 *  no throw). Malformed entries are discarded; the good ones are kept. */
export function normalizeLocations(payload: unknown): LspLocation[] {
  const list = Array.isArray(payload) ? payload : (payload as { locations?: unknown } | null)?.locations
  if (!Array.isArray(list)) return []
  return list.filter(isLocation)
}

/** Raw hover result → LspHover | null. null → null; an object with `contents`
 *  → { contents } (stringified when not a string) plus range when present;
 *  anything else (malformed, no contents) → null. */
export function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null || typeof payload !== "object") return null
  const h = payload as Record<string, unknown>
  if (!("contents" in h)) return null
  // LSP hover contents is never null/undefined; both are malformed → null
  // (JSON.stringify(null) would produce the string "null", so guard first)
  if (h.contents === null || h.contents === undefined) return null
  const contents = typeof h.contents === "string" ? h.contents : JSON.stringify(h.contents)
  if (typeof contents !== "string") return null
  const range = h.range !== undefined && isPosition((h.range as { start?: unknown })?.start) && isPosition((h.range as { end?: unknown })?.end)
    ? (h.range as LspHover["range"])
    : undefined
  return { contents, ...(range !== undefined ? { range } : {}) }
}
