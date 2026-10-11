import { afterEach, expect, it, vi } from "vitest"
import { buildModelClient } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())

it("forwards Codex subscription mode and resolves fresh account credentials through the Responses adapter", async () => {
  let generation = 0
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('data: {"type":"response.completed"}\n\n'))
  vi.stubGlobal("fetch", fetchMock)
  const client = buildModelClient({ name: "codex-account", displayName: "Codex subscription", protocol: "openai-responses", codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: `fixture-${++generation}`, accountId: "fixture-account" }) }, "account-model", { store: true, temperature: 1 })
  for (let index = 0; index < 2; index++) for await (const _event of client.stream({ messages: [], tools: [], systemPrompt: "" })) { /* consume */ }
  expect(fetchMock.mock.calls.map(([url, init]) => [url, new Headers(init.headers).get("authorization")])).toEqual([
    ["https://chatgpt.com/backend-api/codex/responses", "Bearer fixture-1"], ["https://chatgpt.com/backend-api/codex/responses", "Bearer fixture-2"],
  ])
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toMatchObject({ model: "account-model", store: false, stream: true })
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).not.toHaveProperty("temperature")
  expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("ChatGPT-Account-Id")).toBe("fixture-account")
})

it("rejects plan credentials on another protocol", () => {
  expect(() => buildModelClient({ name: "wrong", displayName: "Wrong", protocol: "openai-compatible", codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "fixture", accountId: "fixture-account" }) })).toThrow(/Responses/)
})
