import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { registerWebSearchProvider } from "@i-harness/provider"
import { createWebTools, EXTERNAL_WEB_CONTENT_NOTICE } from "../src/index.ts"
import { createServer } from "node:http"

async function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/html") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(`<html><head><title>My Page</title><style>body{color:red}</style><script>let x=1;</script></head><body><p>Hello &amp; <b>world</b></p></body></html>`)
    } else if (url.pathname === "/text") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("plain text body")
    } else if (url.pathname === "/big") {
      res.writeHead(200, { "content-type": "text/html" })
      res.end(`<html><body>${"a".repeat(200_000)}</body></html>`)
    } else if (url.pathname === "/redirect") { res.writeHead(302, { location: "/html" }); res.end() }
    else { res.writeHead(404); res.end("no") }
  })
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as import("node:net").AddressInfo).port)))
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) }
}

let srv: { port: number; close: () => Promise<void> }
beforeEach(async () => { srv = await startServer() })
afterEach(async () => { await srv.close() })

it("webfetch extracts text: title + stripped markup + entities decoded", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "webfetch")!
  const out = (await t.execute({ url: `http://127.0.0.1:${srv.port}/html` }, {})) as { url: string; title: string; text: string }
  expect(out.title).toBe("My Page")
  expect(out.text).toContain("Hello & world")
  expect(out.text).not.toContain("<b>")
  expect(out.text).not.toContain("style")
})

it("webfetch: plain text passthrough; truncates oversized bodies with a marker", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "webfetch")!
  const plain = (await t.execute({ url: `http://127.0.0.1:${srv.port}/text` }, {})) as { text: string }
  expect(plain.text.trim()).toBe("plain text body")
  const big = (await t.execute({ url: `http://127.0.0.1:${srv.port}/big`, maxChars: 1000 }, {})) as { text: string; truncated: boolean }
  expect(big.truncated).toBe(true)
  expect(big.text.length).toBeLessThan(2000)
})

it("webfetch follows redirects and fails closed on non-http(s) protocol and HTTP errors", async () => {
  const tools = createWebTools({ ctx: createContext() })
  const t = tools.find((x) => x.name === "webfetch")!
  const redir = (await t.execute({ url: `http://127.0.0.1:${srv.port}/redirect` }, {})) as { title: string }
  expect(redir.title).toBe("My Page")
  await expect(t.execute({ url: "file:///etc/passwd" }, {})).rejects.toThrow(/WEB_UNSUPPORTED_PROTOCOL/)
  await expect(t.execute({ url: `http://127.0.0.1:${srv.port}/404` }, {})).rejects.toThrow(/WEB_FETCH_FAILED.*404/)
})

it("websearch without any provider: the tool is NOT registered (zero default, fail-closed)", () => {
  expect(createWebTools({ ctx: createContext() }).map((t) => t.name)).toEqual(["webfetch"])
})

it("websearch dsh contract: url required, title optional; seam caps maxResults and marks truncated", async () => {
  const ctx = createContext()
  const provider = {
    search: vi.fn(async (_req: { query: string; maxResults?: number }) => ({
      sources: [
        { url: "https://a.example", title: "A" },
        { url: "https://b.example", snippet: "no title here", publishedAt: "2026-01-01" },
        { url: "https://c.example" },
        { url: "https://d.example" },
        { url: "https://e.example" },
      ],
      truncated: false,
    })),
  }
  registerWebSearchProvider(ctx, "fake", provider)
  const t = createWebTools({ ctx }).find((x) => x.name === "websearch")!
  const out = await t.execute({ query: "q", maxResults: 3 }, {})
  expect(out).toEqual({
    query: "q",
    sources: [
      { url: "https://a.example", title: "A" },
      { url: "https://b.example", snippet: "no title here", publishedAt: "2026-01-01" },
      { url: "https://c.example" },
    ],
    truncated: true,
    notice: EXTERNAL_WEB_CONTENT_NOTICE,
  })
  // the seam passes the capped maxResults to the provider (cost optimization)
  expect(provider.search.mock.calls[0]![0]).toMatchObject({ query: "q", maxResults: 3 })
})

it("websearch selection: multiple providers without a pin fail at assembly; a pin selects; a ghost pin fails", async () => {
  const ctx = createContext()
  const a = { search: vi.fn(async () => ({ sources: [{ url: "https://a.example" }], truncated: false })) }
  const b = { search: vi.fn(async () => ({ sources: [{ url: "https://b.example" }], truncated: false })) }
  registerWebSearchProvider(ctx, "a", a)
  registerWebSearchProvider(ctx, "b", b)
  expect(() => createWebTools({ ctx })).toThrow(/MULTIPLE_PROVIDERS/)
  const pinned = createWebTools({ ctx, searchProviderId: "a" })
  const out = await pinned.find((x) => x.name === "websearch")!.execute({ query: "x" }, {}) as { sources: Array<{ url: string }> }
  expect(out.sources[0].url).toBe("https://a.example")
  expect(() => createWebTools({ ctx, searchProviderId: "ghost" })).toThrow(/ghost/)
})

it("trust notice: an envelope field on webfetch + websearch results, NEVER concatenated into content", async () => {
  const ctx = createContext()
  registerWebSearchProvider(ctx, "fake", {
    search: async () => ({ sources: [{ url: "https://a.example" }], truncated: false, content: "external body" }),
  })
  const tools = createWebTools({ ctx })
  const wf = tools.find((x) => x.name === "webfetch")!
  const fetched = await wf.execute({ url: `http://127.0.0.1:${srv.port}/text` }, {}) as { notice?: string; text: string }
  expect(fetched.notice).toBe(EXTERNAL_WEB_CONTENT_NOTICE)
  expect(fetched.text).not.toContain("External web content")
  const ws = tools.find((x) => x.name === "websearch")!
  const searched = await ws.execute({ query: "x" }, {}) as {
    notice?: string; content?: string; sources: Array<{ url: string }>
  }
  expect(searched.notice).toBe(EXTERNAL_WEB_CONTENT_NOTICE)
  expect(searched.content).toBe("external body")
  expect(searched.sources[0].url).toBe("https://a.example")
  // The notice lives ONLY in the envelope — never inside content/sources text.
  expect(searched.content).not.toContain("External web content")
  expect(JSON.stringify(searched.sources)).not.toContain("External web content")
})

it("trustNotice: false suppresses the notice field (composition opt-out)", async () => {
  const ctx = createContext()
  registerWebSearchProvider(ctx, "fake", { search: async () => ({ sources: [{ url: "https://a.example" }], truncated: false }) })
  const t = createWebTools({ ctx, trustNotice: false }).find((x) => x.name === "websearch")!
  const out = await t.execute({ query: "x" }, {}) as Record<string, unknown>
  expect("notice" in out).toBe(false)
})
