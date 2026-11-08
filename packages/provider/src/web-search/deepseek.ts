import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from "./registry.ts"

/** Anthropic-compatible Messages endpoint used for native search. */
export const DEEPSEEK_SEARCH_DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic/v1"
export const DEEPSEEK_SEARCH_DEFAULT_MODEL = "deepseek-v4-flash"
export const DEEPSEEK_SEARCH_DEFAULT_API_VERSION = "2023-06-01"
export const DEEPSEEK_SEARCH_DEFAULT_MAX_TOKENS = 4096
export const DEEPSEEK_SEARCH_DEFAULT_MAX_USES = 5

export interface DeepSeekSearchOptions {
  /** Literal key, or a resolver read for each search. */
  apiKey?: string | (() => string | undefined)
  /** Credential ref name reported when no key resolves. */
  apiKeyEnv?: string
  baseURL?: string
  model?: string
  apiVersion?: string
  maxTokens?: number
  maxUses?: number
  fetchImpl?: typeof fetch
}

interface Citation { url?: string; cited_text?: string }
interface ResultItem { type?: string; url?: string; title?: string; page_age?: string }
interface ContentBlock {
  type?: string
  text?: string
  citations?: Citation[]
  content?: ResultItem[]
}
interface MessagesResponse { content?: ContentBlock[] }

const snippetFor = (block: ContentBlock): string | undefined => {
  const citation = block.citations?.find((entry) => typeof entry.cited_text === "string" && entry.cited_text.length > 0)
  return citation?.cited_text
}

/**
 * DeepSeek's native web search runs as the Anthropic server tool
 * `web_search_20250305`; the model answer carries `web_search_tool_result`
 * blocks whose entries become the seam's sources.
 */
export class DeepSeekSearchProvider implements WebSearchProvider {
  readonly id = "deepseek"
  constructor(private readonly options: DeepSeekSearchOptions = {}) {}

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const endpoint = `${(this.options.baseURL ?? DEEPSEEK_SEARCH_DEFAULT_BASE_URL).replace(/\/+$/, "")}/messages`
    const key = typeof this.options.apiKey === "function" ? this.options.apiKey() : this.options.apiKey
    if (key === undefined || key.trim() === "") {
      throw new Error(`DeepSeek web search needs an API key for ${this.options.apiKeyEnv ?? "DEEPSEEK_API_KEY"}`)
    }
    const fetchImpl = this.options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "x-api-key": key,
          authorization: `Bearer ${key}`,
          "anthropic-version": this.options.apiVersion ?? DEEPSEEK_SEARCH_DEFAULT_API_VERSION,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: this.options.model ?? DEEPSEEK_SEARCH_DEFAULT_MODEL,
          max_tokens: this.options.maxTokens ?? DEEPSEEK_SEARCH_DEFAULT_MAX_TOKENS,
          messages: [{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${request.query}` }] }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: this.options.maxUses ?? DEEPSEEK_SEARCH_DEFAULT_MAX_USES }],
        }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw new Error(`DeepSeek web search request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) throw new Error(`DeepSeek web search failed (HTTP ${response.status})`)
    const payload = await response.json() as MessagesResponse
    const blocks = payload.content ?? []
    const snippets = new Map<string, string>()
    for (const block of blocks) {
      const snippet = snippetFor(block)
      const url = block.citations?.find((entry) => entry.cited_text === snippet)?.url
      if (snippet !== undefined && url !== undefined) snippets.set(url, snippet)
    }
    const seen = new Set<string>()
    const sources: WebSearchSource[] = []
    for (const block of blocks) {
      if (block.type !== "web_search_tool_result") continue
      for (const item of block.content ?? []) {
        if (item.type !== "web_search_result" || typeof item.url !== "string" || item.url === "" || seen.has(item.url)) continue
        seen.add(item.url)
        const snippet = snippets.get(item.url)
        sources.push({
          url: item.url,
          ...(item.title == null || item.title === "" ? {} : { title: item.title }),
          ...(snippet == null ? {} : { snippet }),
          ...(item.page_age == null || item.page_age === "" ? {} : { publishedAt: item.page_age }),
        })
      }
    }
    if (sources.length === 0) throw new Error("DeepSeek web search returned no result blocks")
    return { sources, truncated: false }
  }
}
