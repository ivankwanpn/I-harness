import { describe, expect, it, vi } from "vitest"
import { DeepSeekSearchProvider, DEEPSEEK_SEARCH_DEFAULT_BASE_URL } from "../src/web-search/deepseek.ts"
import { TavilySearchProvider, TAVILY_SEARCH_ENDPOINT } from "../src/web-search/tavily.ts"

describe("DeepSeekSearchProvider", () => {
  it("sends the native web_search tool and maps result blocks", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response(JSON.stringify({ content: [
        { type: "text", text: "answer", citations: [{ url: "https://a.example/1", cited_text: "first snippet" }] },
        { type: "web_search_tool_result", content: [
          { type: "web_search_result", url: "https://a.example/1", title: "A", page_age: "2026-01-01" },
          { type: "web_search_result", url: "https://b.example/2", title: "B" },
        ] },
      ] }), { status: 200 })
    }) as unknown as typeof fetch
    const provider = new DeepSeekSearchProvider({ apiKey: "secret", fetchImpl })
    const result = await provider.search({ query: "hello" })
    expect(calls[0]!.url).toBe(DEEPSEEK_SEARCH_DEFAULT_BASE_URL + "/messages")
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers["x-api-key"]).toBe("secret")
    expect(headers["anthropic-version"]).toBe("2023-06-01")
    const body = JSON.parse(String(calls[0]!.init.body))
    expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }])
    expect(body.messages[0].content[0].text).toContain("hello")
    expect(result.sources).toEqual([
      { url: "https://a.example/1", title: "A", snippet: "first snippet", publishedAt: "2026-01-01" },
      { url: "https://b.example/2", title: "B" },
    ])
  })

  it("drops null optional fields instead of emitting them", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ content: [
      { type: "web_search_tool_result", content: [
        { type: "web_search_result", url: "https://a.example/1", title: null, page_age: null },
      ] },
    ] }), { status: 200 })) as unknown as typeof fetch
    const result = await new DeepSeekSearchProvider({ apiKey: "k", fetchImpl }).search({ query: "x" })
    expect(result.sources).toEqual([{ url: "https://a.example/1" }])
  })

  it("refuses without a key and reports no result blocks", async () => {
    await expect(new DeepSeekSearchProvider({}).search({ query: "x" })).rejects.toThrow(/API key/)
    const fetchImpl = (async () => new Response(JSON.stringify({ content: [] }), { status: 200 })) as unknown as typeof fetch
    await expect(new DeepSeekSearchProvider({ apiKey: "k", fetchImpl }).search({ query: "x" })).rejects.toThrow(/no result blocks/)
  })
})

describe("TavilySearchProvider", () => {
  it("uses keyless mode without a key and maps results", async () => {
    const calls: RequestInit[] = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init!)
      return new Response(JSON.stringify({ results: [
        { title: "T", url: "https://t.example/1", content: "snippet" },
      ] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await new TavilySearchProvider({ fetchImpl }).search({ query: "q", maxResults: 3 })
    const headers = calls[0]!.headers as Record<string, string>
    expect(headers["x-tavily-access-mode"]).toBe("keyless")
    expect(headers.authorization).toBeUndefined()
    expect(JSON.parse(String(calls[0]!.body)).max_results).toBe(3)
    expect(result.sources).toEqual([{ url: "https://t.example/1", title: "T", snippet: "snippet" }])
    expect(TAVILY_SEARCH_ENDPOINT).toBe("https://api.tavily.com/search")
  })

  it("sends bearer auth when a key is configured", async () => {
    let headers: Record<string, string> = {}
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = init!.headers as Record<string, string>
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await new TavilySearchProvider({ apiKey: "tv", fetchImpl }).search({ query: "q" })
    expect(headers.authorization).toBe("Bearer tv")
    expect(headers["x-tavily-access-mode"]).toBeUndefined()
  })
})