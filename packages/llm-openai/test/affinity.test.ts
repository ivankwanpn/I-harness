import { afterEach, expect, it, vi } from "vitest"
import { createRetryingClient, createWaitingGuard, resolveRetryPolicy, type LLMRequest, type ModelClient } from "@i-harness/llm-seam"
import { createOpenAIClient } from "../src/index.ts"

const completed = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":8}}}}\n\n'
const input: LLMRequest = { messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "Help" }
const scope = (sessionId = "session-a", turnId = "turn-a", isSubagent = false) => Object.freeze({ sessionId, turnId, isSubagent })
const collect = async (client: ModelClient, request: LLMRequest) => { const events = []; for await (const event of client.stream(request)) events.push(event); return events }
const plan = (extra = {}) => createOpenAIClient({ apiKey: "unused", model: "model", codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "fixture", accountId: "account-a" }), ...extra })
const response = (token?: string) => new Response(completed, { headers: token === undefined ? {} : { "x-codex-turn-state": token } })
afterEach(() => vi.unstubAllGlobals())

it("uses stable session affinity and actual thread identity, replaying only the first valid sticky value in a turn", async () => {
  const seen: RequestInit[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { seen.push(init); return response(`sticky-${seen.length}`) })
  const client = plan()
  const request = { ...input, requestScope: scope(), promptCache: { key: "stable-cache-key" } }
  for (let i = 0; i < 3; i++) await collect(client, request)
  expect(seen.map(init => new Headers(init.headers).get("session-id"))).toEqual(Array(3).fill("stable-cache-key"))
  expect(seen.map(init => new Headers(init.headers).get("thread-id"))).toEqual(Array(3).fill("session-a"))
  expect(seen.map(init => new Headers(init.headers).get("x-codex-turn-state"))).toEqual([null, "sticky-1", "sticky-1"])
  expect(seen.map(init => JSON.parse(init.body as string).prompt_cache_key)).toEqual(Array(3).fill("stable-cache-key"))
  expect(JSON.stringify(seen.map(init => JSON.parse(init.body as string)))).not.toMatch(/requestScope|turnId|sessionId|sticky-/)
})

it("isolates new turns, child sessions and unscoped calls on an inherited client", async () => {
  const headers: Headers[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { headers.push(new Headers(init.headers)); return response(`token-${headers.length}`) })
  const client = plan()
  const parent = { ...input, requestScope: scope(), promptCache: { key: "root-custom" } }
  const child = { ...parent, requestScope: scope("child", "child-turn", true) }
  await collect(client, parent); await collect(client, child); await collect(client, parent); await collect(client, child)
  await collect(client, { ...parent, requestScope: scope("session-a", "turn-b") })
  await collect(client, input); await collect(client, input)
  expect(headers.map(h => h.get("x-codex-turn-state"))).toEqual([null, null, "token-1", "token-2", null, null, null])
  expect(headers[1]!.get("session-id")).toBe("child")
  expect(headers[1]!.get("thread-id")).toBe("child")
  expect(headers[4]!.get("session-id")).toBe("root-custom")
  expect(headers[5]!.get("session-id")).toBeNull()
})

it("drops account-owned state on account changes and ignores old-account late responses", async () => {
  const headers: Headers[] = []; let accountId = "a"; let finish!: (value: Response) => void
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { headers.push(new Headers(init.headers)); return headers.length === 1 ? new Promise<Response>(resolve => { finish = resolve }) : response(`token-${headers.length}`) })
  const client = plan({ resolveCodexAuth: async () => ({ accessToken: "fixture", accountId }) })
  const request = { ...input, requestScope: scope() }
  const old = collect(client, request)
  await vi.waitFor(() => expect(headers).toHaveLength(1))
  accountId = "b"; await collect(client, request)
  finish(response("old-account")); await old
  await collect(client, request)
  accountId = "a"; await collect(client, request)
  expect(headers.map(h => h.get("x-codex-turn-state"))).toEqual([null, null, "token-2", null])
})

it.each([["empty", ""], ["oversized", "x".repeat(4097)], ["DEL", "unsafe\u007fvalue"], ["tab", "unsafe\tvalue"], ["non-ASCII", "非ASCII"], ["newline", "unsafe\r\nvalue"]])("ignores invalid or oversized response state (%s)", async (_label, token) => {
  const headers: Headers[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    headers.push(new Headers(init.headers))
    const result = response(headers.length === 1 ? undefined : "valid")
    if (headers.length === 1) vi.spyOn(result.headers, "get").mockReturnValue(token)
    return result
  })
  const client = plan(); const request = { ...input, requestScope: scope() }
  await collect(client, request); await collect(client, request); await collect(client, request)
  expect(headers.map(h => h.get("x-codex-turn-state"))).toEqual([null, null, "valid"])
})

it("does not replay state when a raw caller mutates scope identity, including child origin", async () => {
  const headers: Headers[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { headers.push(new Headers(init.headers)); return response(`token-${headers.length}`) })
  const requestScope = { sessionId: "a", turnId: "turn", isSubagent: false }
  const request = { ...input, requestScope }; const client = plan()
  await collect(client, request)
  requestScope.isSubagent = true; await collect(client, request)
  requestScope.sessionId = "b"; await collect(client, request)
  requestScope.turnId = "next"; await collect(client, request)
  expect(headers.map(h => h.get("x-codex-turn-state"))).toEqual([null, null, null, null])
})

it("ignores a late response after scope mutation even when no newer response has arrived", async () => {
  let finish!: (value: Response) => void
  const headers: Headers[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { headers.push(new Headers(init.headers)); return headers.length === 1 ? new Promise<Response>(resolve => { finish = resolve }) : response() })
  const requestScope = { sessionId: "a", turnId: "turn", isSubagent: false }
  const request = { ...input, requestScope }; const client = plan()
  const pending = collect(client, request); await vi.waitFor(() => expect(headers).toHaveLength(1))
  requestScope.isSubagent = true
  finish(response("old-root")); await pending
  requestScope.isSubagent = false
  await collect(client, request)
  expect(headers[1]!.get("x-codex-turn-state")).toBeNull()
})

it("snapshots scope before asynchronous account resolution so a raw mutation cannot mix identities on one request", async () => {
  let resolveAuth!: () => void
  let started = false
  const headers: Headers[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { headers.push(new Headers(init.headers)); return response("old-route") })
  const client = plan({ resolveCodexAuth: async () => { started = true; await new Promise<void>(resolve => { resolveAuth = resolve }); return { accessToken: "fixture", accountId: "a" } } })
  const requestScope = { sessionId: "original", turnId: "original-turn" }
  const pending = collect(client, { ...input, requestScope })
  await vi.waitFor(() => expect(started).toBe(true))
  requestScope.sessionId = "different"; requestScope.turnId = "different-turn"
  resolveAuth(); await pending
  expect(headers[0]!.get("thread-id")).toBe("original")
})

it("bounds and safely encodes arbitrary session identities without changing their host metadata", async () => {
  const headers: Headers[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { headers.push(new Headers(init.headers)); return response() })
  const client = plan(); const request = { ...input, requestScope: scope("private\r\n" + "長".repeat(500)) }
  await collect(client, request); await collect(client, { ...request, requestScope: scope(request.requestScope.sessionId, "next") })
  expect(headers[0]!.get("session-id")).toMatch(/^ih_[a-f0-9]{48}$/)
  expect(headers[0]!.get("thread-id")).toMatch(/^ih_[a-f0-9]{48}$/)
  expect(headers[1]!.get("session-id")).toBe(headers[0]!.get("session-id"))
  expect(request.requestScope.sessionId).toContain("private\r\n")
})

it("preserves explicit off and custom cache key intent", async () => {
  const seen: RequestInit[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { seen.push(init); return response() })
  const request = { ...input, requestScope: scope(), promptCache: { key: "default-key" } }
  await collect(plan({ options: { prompt_cache_key: "custom-key" } }), request)
  await collect(plan({ promptCache: { mode: "off" }, options: { prompt_cache_key: "custom-key" } }), request)
  await collect(plan({ promptCache: { mode: "automatic" } }), { ...request, promptCache: { mode: "off" } })
  expect(seen.map(init => JSON.parse(init.body as string).prompt_cache_key)).toEqual(["custom-key", undefined, undefined])
  expect(seen.map(init => new Headers(init.headers).get("session-id"))).toEqual(["custom-key", null, null])
})

it.each([undefined, "https://custom.example"])("keeps API-key Responses payloads and user headers unchanged (%s)", async baseUrl => {
  const seen: RequestInit[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { seen.push(init); return response("subscription-only") })
  const client = createOpenAIClient({ apiKey: "api-key", model: "codex", baseUrl, headers: { "session-id": "user-session", "x-codex-turn-state": "user-state" } })
  await collect(client, input); await collect(client, { ...input, requestScope: scope(), promptCache: { key: "affinity" } })
  expect(seen[1]!.body).toBe(seen[0]!.body)
  expect(seen[1]!.headers).toEqual(seen[0]!.headers)
  expect(new Headers(seen[1]!.headers).get("thread-id")).toBeNull()
})

it("replays accepted response affinity through the guard and retry without changing usage counters", async () => {
  const headers: Headers[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    headers.push(new Headers(init.headers))
    return headers.length === 1
      ? new Response('data: {"type":"error","code":"server_error","message":"fixture"}\n\n', { headers: { "x-codex-turn-state": "first-route" } })
      : response("later-route")
  })
  const client = createRetryingClient(createWaitingGuard(plan(), { firstResponseMs: 1000, progressMs: 1000 }), resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const events = await collect(client, { ...input, requestScope: scope() })
  expect(headers.map(h => h.get("x-codex-turn-state"))).toEqual([null, "first-route"])
  expect(events.filter(event => event.type === "usage")).toEqual([{ type: "usage", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, inputTokenSemantics: "includes-cache" } }])
  const attempts = events.filter(event => event.type === "activity" && event.activity.phase === "connecting")
  expect(new Set(attempts.map(event => event.type === "activity" && event.activity.requestId)).size).toBe(2)
  expect(events.at(-1)!.type).toBe("end")
})

it("ignores a timed-out physical attempt's late headers within the same turn", async () => {
  let finish!: (value: Response) => void
  const headers: Headers[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    headers.push(new Headers(init.headers))
    return headers.length === 1 ? new Promise<Response>(resolve => { finish = resolve }) : response("current-route")
  })
  const raw = plan(); const request = { ...input, requestScope: scope() }
  const guarded = createWaitingGuard(raw, { firstResponseMs: 15, progressMs: 1000 })
  const client = createRetryingClient(guarded, resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const events = await collect(client, request)
  finish(response("timed-out-route"))
  await new Promise(resolve => setTimeout(resolve, 0))
  await collect(raw, request)
  expect(headers.map(h => h.get("x-codex-turn-state"))).toEqual([null, null, "current-route"])
  expect(events.at(-1)!.type).toBe("end")
})

it("keeps late previous-turn responses and client rebuilds separate from the current turn", async () => {
  let finish!: (value: Response) => void
  const headers: Headers[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { headers.push(new Headers(init.headers)); return headers.length === 1 ? new Promise<Response>(resolve => { finish = resolve }) : response("current-route") })
  const client = plan(); const current = { ...input, requestScope: scope("a", "new") }
  const old = collect(client, { ...input, requestScope: scope("a", "old") })
  await vi.waitFor(() => expect(headers).toHaveLength(1))
  await collect(client, current); finish(response("old-route")); await old
  await collect(client, current)
  await collect(plan(), current)
  await collect(client, { ...current, requestScope: { ...current.requestScope } })
  expect(headers.map(h => h.get("x-codex-turn-state"))).toEqual([null, null, "current-route", null, null])
})
