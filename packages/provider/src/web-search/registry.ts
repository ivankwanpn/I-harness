// ── M26-B3 → M31: websearch provider seam（同 interaction/questions 模式）──
// M31 契約升級（spec §3.1, dsh-honest）：websearch 全鏈對「當下一個 provider 的
// 真實所見」負責——sources 行是 {url 必需, title/snippet/publishedAt 可選}，可用
// `truncated` 標記告知結果被裁剪（誠信：不逼 provider 編造 title/日期）；maxResults
// 由 seam 層強制（截斷在此執行）。註冊帶 id（多 provider 可駐留）；選擇 = 釘選 id
// > 唯一可用 > 失敗（dsh WebError 語義）。零默認：無內建 provider 註冊。
import type { PluginContext } from "@i-harness/core-plugin"

export interface WebSearchRequest {
  query: string
  maxResults?: number
}

/** One search result row: `url` is the only required field — a provider must
 * never be forced to invent a title or date it does not know. */
export interface WebSearchSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

/** The provider's honest view of one search: the truncation boundary is the
 * seam's job (`truncated` marks it); `content` is an optional named summary. */
export interface WebSearchResult {
  content?: string
  sources: WebSearchSource[]
  truncated: boolean
}

/** Contract of a registered websearch provider. `signal` comes from the
 * calling tool's execution context (abort on tool timeout/disconnect). */
export interface WebSearchProvider {
  search(req: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/** Id-keyed registration (dsh searchProviderId pin surface): one ctx slot holds
 * the map; duplicate service-name registration is the services registry's own
 * failure class + a duplicate ID fails loud (two plugins claiming one id is a
 * composition bug). */
export function registerWebSearchProvider(ctx: PluginContext, id: string, provider: WebSearchProvider): void {
  if (id === "") throw new Error("websearch provider id must be a non-empty string")
  let providers: Map<string, WebSearchProvider>
  try {
    providers = ctx.services.get<Map<string, WebSearchProvider>>("websearch/provider")
  } catch {
    providers = new Map()
    ctx.services.register("websearch/provider", providers)
  }
  if (providers.has(id)) throw new Error(`duplicate websearch provider id: ${id}`)
  providers.set(id, provider)
}

/** Selection per spec §3.1: pinned id > exactly-one usable > error. Returns
 * undefined when NO provider is registered at all — the websearch tool is then
 * simply not registered (the zero-default fail-closed stance); a pin that does
 * not resolve or multiple candidates without a pin THROW (misconfiguration —
 * fail loud at assembly, never a silent drop). */
export function tryGetWebSearchProvider(ctx: PluginContext, pinnedId?: string): WebSearchProvider | undefined {
  let providers: Map<string, WebSearchProvider>
  try {
    providers = ctx.services.get<Map<string, WebSearchProvider>>("websearch/provider")
  } catch {
    return undefined
  }
  if (pinnedId !== undefined) {
    const provider = providers.get(pinnedId)
    if (provider === undefined) {
      throw new Error(`websearch provider ${pinnedId} is not registered (NO_PROVIDER)`)
    }
    return provider
  }
  if (providers.size === 0) return undefined
  if (providers.size === 1) return [...providers.values()][0]!
  const ids = [...providers.keys()].sort().join(", ")
  throw new Error(`multiple websearch providers registered (${ids}); pin one via searchProviderId (MULTIPLE_PROVIDERS)`)
}

// fail-closed：無 provider → 同步 throw（NO_PROVIDER），呼叫端（web 工具）不需 await 就看到。
export function getWebSearchProvider(ctx: PluginContext, pinnedId?: string): WebSearchProvider {
  const provider = tryGetWebSearchProvider(ctx, pinnedId)
  if (provider === undefined) throw new Error("no websearch provider is registered (NO_PROVIDER)")
  return provider
}
