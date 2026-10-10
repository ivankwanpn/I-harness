import { mkdtemp, mkdir } from "node:fs/promises"
import { resolve, join } from "node:path"
import { expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { registerWebSearchProvider } from "@i-harness/provider"
import { createWebTools, createWebCache, EXTERNAL_WEB_CONTENT_NOTICE } from "../src/index.ts"

const url = "https://test.example/page"
it("disabled omits tools; a live policy change refuses before either external effect", async () => {
  const ctx = createContext()
  const fetchImpl = vi.fn(async () => new Response("body"))
  const search = vi.fn(async () => ({sources: [{url}], truncated: false}))
  registerWebSearchProvider(ctx, "fixture", {search})
  expect(createWebTools({ctx, mode: "disabled", fetchImpl})).toEqual([])
  let mode: "live" | "disabled" = "live"
  const tools = createWebTools({ctx, mode: () => mode, fetchImpl})
  mode = "disabled"
  for (const tool of tools) await expect(tool.execute({url, query: "x"}, {})).rejects.toThrow("WEB_DISABLED")
  expect(fetchImpl).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled()
})

it("cached hits survive reload, misses do not call fetch or the provider", async () => {
  const base = resolve("../../.tmp"); await mkdir(base, {recursive: true})
  const root = await mkdtemp(join(base, "wsl-product-web-"))
  const ctx = createContext()
  const search = vi.fn(async () => ({sources: [{url}], truncated: false}))
  registerWebSearchProvider(ctx, "fixture", {search})
  const fetchImpl = vi.fn(async () => new Response("saved page", {headers: {"content-type": "text/plain"}}))
  const live = createWebTools({ctx, mode: "live", cache: createWebCache({root, scope: "workspace-a"}), fetchImpl})
  await live.find(t => t.name === "webfetch")!.execute({url}, {})
  await live.find(t => t.name === "websearch")!.execute({query: "known"}, {})
  fetchImpl.mockClear(); search.mockClear()
  const cached = createWebTools({ctx, mode: "cached", cache: createWebCache({root, scope: "workspace-a"}), fetchImpl})
  expect(await cached[0]!.execute({url}, {})).toMatchObject({text: "saved page", access: "cached", notice: EXTERNAL_WEB_CONTENT_NOTICE})
  expect(await cached[1]!.execute({query: "known"}, {})).toMatchObject({sources: [{url}], access: "cached"})
  await expect(cached[0]!.execute({url: "https://test.example/missing"}, {})).rejects.toThrow("WEB_CACHE_MISS")
  await expect(cached[1]!.execute({query: "unknown"}, {})).rejects.toThrow("WEB_CACHE_MISS")
  const other = createWebTools({ctx, mode: "cached", cache: createWebCache({root, scope: "workspace-b"}), fetchImpl})
  await expect(other[0]!.execute({url}, {})).rejects.toThrow("WEB_CACHE_MISS")
  expect(fetchImpl).not.toHaveBeenCalled(); expect(search).not.toHaveBeenCalled()
})

it("indexed admits current provider results and checks every redirect before fetching", async () => {
  const ctx = createContext()
  const redirect = "https://test.example/redirect"
  registerWebSearchProvider(ctx, "fixture", {search: async () => ({sources: [{url}, {url: redirect}], truncated: false})})
  const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => String(input) === redirect
    ? new Response(null, {status: 302, headers: {location: "https://outside.example/secret"}})
    : new Response("indexed page"))
  const tools = createWebTools({ctx, mode: "indexed", fetchImpl})
  await expect(tools[0]!.execute({url}, {})).rejects.toThrow("WEB_NOT_INDEXED")
  expect(fetchImpl).not.toHaveBeenCalled()
  await tools[1]!.execute({query: "x"}, {})
  expect(await tools[0]!.execute({url}, {})).toMatchObject({text: "indexed page", access: "indexed"})
  await expect(tools[0]!.execute({url: redirect}, {})).rejects.toThrow("WEB_NOT_INDEXED")
  expect(fetchImpl.mock.calls.map(call => String(call[0]))).toEqual([url, redirect])
  expect(fetchImpl.mock.calls.every(call => (call[1] as RequestInit)?.redirect === "manual")).toBe(true)
  const replacement = createContext()
  registerWebSearchProvider(replacement, "fixture", {search: async () => ({sources: [], truncated: false})})
  await expect(createWebTools({ctx: replacement, mode: "indexed", fetchImpl})[0]!.execute({url}, {})).rejects.toThrow("WEB_NOT_INDEXED")
})

it("cached and indexed modes still expose no search without a provider", () => {
  for (const mode of ["cached", "indexed"] as const) expect(createWebTools({ctx: createContext(), mode}).map(t => t.name)).toEqual(["webfetch"])
})

it("a replacement provider cannot reuse saved queries or acquire old index grants", async () => {
  const cache = createWebCache()
  const before = createContext()
  registerWebSearchProvider(before, "same-id", {search: async () => ({sources: [{url}], truncated: false})})
  await createWebTools({ctx: before, mode: "live", cache})[1]!.execute({query: "x"}, {})
  const after = createContext()
  const search = vi.fn(async () => ({sources: [], truncated: false}))
  registerWebSearchProvider(after, "same-id", {search})
  await expect(createWebTools({ctx: after, mode: "cached", cache})[1]!.execute({query: "x"}, {})).rejects.toThrow("WEB_CACHE_MISS")
  expect(search).not.toHaveBeenCalled()
})

it("search output and saved page bodies remain bounded even for oversized external chunks", async () => {
  const ctx = createContext()
  registerWebSearchProvider(ctx, "huge", {search: async () => ({content: "x".repeat(500_000), sources: Array.from({length: 40}, () => ({url, snippet: "s".repeat(200_000)})), truncated: false})})
  const tools = createWebTools({ctx, mode: "live", fetchImpl: async () => new Response("p".repeat(2_000_000))})
  const found = await tools[1]!.execute({query: "x"}, {}) as {content: string; sources: {snippet: string}[]; truncated: boolean}
  expect(found.content.length).toBeLessThan(129_000)
  expect(found.sources).toHaveLength(20)
  expect(found.sources[0]!.snippet.length).toBeLessThan(9000)
  expect(found.truncated).toBe(true)
  expect(await tools[0]!.execute({url}, {})).toMatchObject({bodyTruncated: true, truncated: true})
})

it("validates and caps cached search payloads at the external content boundary", async () => {
  const ctx = createContext()
  const search = vi.fn(async () => ({sources: [], truncated: false}))
  registerWebSearchProvider(ctx, "fixture", {search})
  let saved: unknown = {content: "c".repeat(300_000), sources: [{url, title: "t".repeat(100_000), snippet: "s".repeat(100_000)}], truncated: false}
  const tools = createWebTools({ctx, mode: "cached", cache: {get: async () => saved as never, put: async () => true}})
  const output = await tools[1]!.execute({query: "x"}, {}) as {content: string; sources: {title: string; snippet: string}[]; truncated: boolean}
  expect(output.content.length).toBeLessThan(129_000)
  expect(output.sources[0]!.title.length).toBeLessThan(5000)
  expect(output.sources[0]!.snippet.length).toBeLessThan(9000)
  expect(output.truncated).toBe(true)
  saved = {sources: "malformed"}
  await expect(tools[1]!.execute({query: "x"}, {})).rejects.toThrow("WEB_CACHE_MISS")
  expect(search).not.toHaveBeenCalled()
})

it("bounds page titles for live and cached pages regardless of maxChars", async () => {
  const cache = createWebCache()
  const ctx = createContext()
  const live = createWebTools({ctx, mode: "live", cache, fetchImpl: async () => new Response(`<title>${"t".repeat(500_000)}</title>body`, {headers: {"content-type": "text/html"}})})
  const fetched = await live[0]!.execute({url, maxChars: 4}, {}) as {title: string; truncated: boolean}
  expect(fetched.title.length).toBeLessThan(5000)
  expect(fetched.truncated).toBe(true)
  const cached = createWebTools({ctx, mode: "cached", cache})
  const restored = await cached[0]!.execute({url, maxChars: 4}, {}) as {title: string; truncated: boolean}
  expect(restored.title.length).toBeLessThan(5000)
  expect(restored.truncated).toBe(true)
})
