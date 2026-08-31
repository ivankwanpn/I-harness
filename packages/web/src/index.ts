import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool } from "@i-harness/core-tools"
import { getWebSearchProvider } from "@i-harness/provider"
import { capText, DEFAULT_MAX_CHARS, DEFAULT_FETCH_MAX_BYTES, extractText, extractTitle, readBodyLimited } from "./extract.ts"

export interface WebToolDeps { ctx: PluginContext; fetchImpl?: typeof fetch }

export function createWebTools(deps: WebToolDeps): Tool[] {
  const fetchImpl = deps.fetchImpl ?? fetch
  return [
    {
      name: "webfetch",
      description:
        "Fetch a web page and return its extracted text (HTML tags stripped, title detected). http/https only; bounded to maxChars (default 128000, head-tail) — huge pages are truncated with a marker.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, maxChars: { type: "number" } }, required: ["url"] },
      timeoutMs: 30_000,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async (args: { url: string; maxChars?: number }, exec) => {
        let u: URL
        try { u = new URL(args.url) } catch { throw new Error(`WEB_UNSUPPORTED_PROTOCOL: "${args.url}" cannot be parsed as an absolute URL`) }
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          throw new Error(`WEB_UNSUPPORTED_PROTOCOL: only http/https are allowed (got "${u.protocol}")`)
        }
        let res: Response
        try {
          res = await fetchImpl(u, { redirect: "follow", signal: exec.abortSignal, headers: { "user-agent": "i-harness/0.1" } })
        } catch (err) {
          throw new Error(`WEB_FETCH_FAILED: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!res.ok) throw new Error(`WEB_FETCH_FAILED: HTTP ${res.status} ${res.statusText}`)
        const { text: body, truncatedAt } = await readBodyLimited(res, DEFAULT_FETCH_MAX_BYTES)
        const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS
        const title = extractTitle(body)
        const cap = capText(extractText(body, res.headers.get("content-type")), maxChars)
        return {
          url: u.href,
          ...(title !== undefined ? { title } : {}),
          text: cap.text,
          ...(cap.truncated ? { truncated: true, note: "output truncated (head-tail); see the original URL or search for more" } : {}),
          ...(truncatedAt !== null ? { bodyTruncated: true } : {}),
        }
      },
    },
    {
      name: "websearch",
      description:
        "Search the web through the configured search provider (results are title/url/snippet items). Fails closed when no provider is registered.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number", maximum: 20 } }, required: ["query"] },
      timeoutMs: 30_000,
      isReadOnly: true,
      isConcurrencySafe: true,
      execute: async (args: { query: string; maxResults?: number }) => {
        const provider = getWebSearchProvider(deps.ctx) // 無 provider → NO_PROVIDER throw
        const results = await provider.search({ query: args.query, ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}) })
        return { query: args.query, results }
      },
    },
  ]
}

export function registerWeb(ctx: PluginContext, tools: { register(t: Tool): void }): void {
  for (const tool of createWebTools({ ctx })) tools.register(tool)
}
