import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from "./registry.ts"

export const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search"

export interface TavilySearchOptions {
  apiKey?: string | (() => string | undefined)
  endpoint?: string
  /** Requested results when the call carries no cap. */
  maxResults?: number
  fetchImpl?: typeof fetch
}

interface TavilyResponse { results?: { title?: string; url?: string; content?: string }[] }

/** Tavily accepts keyless calls (rate limited); a key upgrades the quota. */
export class TavilySearchProvider implements WebSearchProvider {
  readonly id = "tavily"
  constructor(private readonly options: TavilySearchOptions = {}) {}

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const key = typeof this.options.apiKey === "function" ? this.options.apiKey() : this.options.apiKey
    const fetchImpl = this.options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(this.options.endpoint ?? TAVILY_SEARCH_ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(key === undefined || key.trim() === "" ? { "x-tavily-access-mode": "keyless" } : { authorization: `Bearer ${key}` }),
        },
        body: JSON.stringify({
          query: request.query,
          search_depth: "basic",
          chunks_per_source: 3,
          max_results: Math.max(1, Math.min(20, request.maxResults ?? this.options.maxResults ?? 8)),
        }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw new Error(`Tavily web search request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`Tavily web search failed (HTTP ${response.status})`)
    const payload = await response.json() as TavilyResponse
    const sources = (payload.results ?? [])
      .filter((entry): entry is { title?: string; url: string; content?: string } => typeof entry.url === "string" && entry.url !== "")
      .map((entry) => ({
        url: entry.url,
        ...(entry.title == null || entry.title === "" ? {} : { title: entry.title }),
        ...(entry.content == null || entry.content === "" ? {} : { snippet: entry.content }),
      }))
    return { sources, truncated: false }
  }
}
