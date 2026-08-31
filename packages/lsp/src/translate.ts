// Normalization seam: raw LSP wire payloads → the package's Lsp types.
// Pure functions (no instance/connection coupling); used by instance.ts for
// query conversions (doQuery) and by tools that receive raw payloads.
import type { LspCallHierarchyCall, LspCallHierarchyItem, LspHover, LspLocation, LspPosition, LspRange, LspSymbol } from "./instance.ts"
import { isPos } from "./instance.ts"

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

// ---------- M26-B5 ----------

/** SymbolInformation 帶 `location: { uri, range }`；DocumentSymbol 帶扁平 `range` +
 *  selectionRange（uri 由開檔 document 提供）。兩形都收。 */
function locOf(raw: unknown): LspLocation | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.uri === "string") {
    const range = o.range as Record<string, unknown> | undefined
    if (typeof range !== "object" || range === null || !isPos(range.start) || !isPos(range.end)) return undefined
    return { uri: o.uri, range: range as unknown as LspRange }
  }
  // SymbolInformation：location = { uri, range }
  const loc = o.location as Record<string, unknown> | undefined
  if (typeof loc === "object" && loc !== null && typeof loc.uri === "string") {
    const range = loc.range as Record<string, unknown> | undefined
    if (typeof range !== "object" || range === null || !isPos(range.start) || !isPos(range.end)) return undefined
    return { uri: loc.uri, range: range as unknown as LspRange }
  }
  return undefined
}

/**
 * textDocument/documentSymbol：DocumentSymbol[]（階層）或 SymbolInformation[]（扁平）混收，
 * 階層性 children 深度優先平鋪（LSP 慣例：SymbolInformation 無 children）。
 * DocumentSymbol 先天沒有 uri——documentUri 是開檔的那份（workspaceSymbol 不需給，丟無 uri 項）。
 * fail-closed：缺 name/kind 或不可解析位置的 entry 丟棄；payload 非陣列 → []。
 */
export function normalizeSymbols(payload: unknown, documentUri?: string): LspSymbol[] {
  if (!Array.isArray(payload)) return []
  const out: LspSymbol[] = []
  const walk = (items: unknown[]): void => {
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue
      const d = item as Record<string, unknown>
      if (typeof d.name !== "string" || typeof d.kind !== "number") continue
      const location = locOf(d) // SymbolInformation 帶 location；DocumentSymbol 無
      if (!location) {
        // DocumentSymbol：uri 由開檔 document 注入 + selectionRange 直接上位
        if (documentUri === undefined || !isPos((d.selectionRange as Record<string, unknown>)?.start)) continue
      }
      const loc: LspLocation =
        location ?? { uri: documentUri!, range: d.selectionRange as LspRange }
      out.push({
        name: d.name, kind: d.kind, uri: loc.uri, range: loc.range,
        ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
      })
      if (Array.isArray(d.children)) walk(d.children)
    }
  }
  walk(payload)
  return out
}

const itemOf = (raw: unknown): LspCallHierarchyItem | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const d = raw as Record<string, unknown>
  if (typeof d.name !== "string" || typeof d.kind !== "number" || typeof d.uri !== "string") return undefined
  if (!isPos((d.selectionRange as Record<string, unknown>)?.start)) return undefined
  return {
    name: d.name, kind: d.kind, uri: d.uri,
    range: d.range as LspRange, selectionRange: d.selectionRange as LspRange,
    ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
    ...(d.data !== undefined ? { data: d.data } : {}),
  }
}

/** textDocument/prepareCallHierarchy → items；空/畸形 → []（fail-closed）。 */
export function normalizeCallHierarchyItems(payload: unknown): LspCallHierarchyItem[] {
  if (!Array.isArray(payload)) return []
  return payload.map(itemOf).filter((i): i is LspCallHierarchyItem => i !== undefined)
}

/** callHierarchy/incomingCalls |outgoingCalls 的 wire 是 { items?: array }。 */
export function normalizeCallHierarchyCalls(payload: unknown): LspCallHierarchyCall[] {
  if (typeof payload !== "object" || payload === null) return []
  const items = (payload as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const out: LspCallHierarchyCall[] = []
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue
    const e = entry as Record<string, unknown>
    const item = itemOf(e.item)
    if (!item) continue
    const fromRanges = Array.isArray(e.fromRanges)
      ? (e.fromRanges as unknown[]).filter((r) => isPos((r as Record<string, unknown>)?.start) && isPos((r as Record<string, unknown>)?.end)).map((r) => r as LspRange)
      : []
    out.push({ item, fromRanges })
  }
  return out
}
