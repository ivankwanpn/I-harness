import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { SettingsStore } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { createProviderRegistry } from "@i-harness/provider"
import { createProviderRuntime } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(extra: Record<string, unknown> = {}) {
  const path = await mkdtemp(join(tmpdir(), "ih-plan-runtime-")); roots.push(path)
  const settings = new SettingsStore({ path: join(path, "settings.json") }); await settings.load()
  await settings.set({ llm: { providers: { plan: { oauthAccountId: "account-a", oauthProvider: "openai-codex", baseURL: "https://chatgpt.com/backend-api/codex", protocol: "openai-responses", models: [{ id: "model-a" }], ...extra } }, defaultModel: { provider: "plan", model: "model-a" } } })
  const token = vi.fn(async () => ({ accessToken: "access-one", accountId: "workspace-a" }))
  const codex = { state: async () => ({ accountId: "account-a", status: "connected" }), token, models: vi.fn(async () => [{ id: "model-a", name: "Model A" }]) }
  const runtime = createProviderRuntime({ settings, credentials: createCredentialStore(join(path, "keys.json")), registry: createProviderRegistry(), codex })
  return { settings, runtime, codex }
}
it("persists an account reference, discovers account models and identifies OAuth without storing a token", async () => {
  const f = await fixture(); await f.settings.load()
  expect((f.settings.get().llm.providers.plan as any).oauthAccountId).toBe("account-a")
  expect((await f.runtime.directory())[0]?.auth).toEqual({ configured: true, source: "oauth", writable: false })
  expect(await f.runtime.probeModels("plan")).toEqual([{ id: "model-a", name: "Model A" }])
})
it("uses the existing Responses adapter and re-resolves credentials for every stream", async () => {
  const f = await fixture(); const requests: { url: string; token: string; body: any }[] = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), token: new Headers(init.headers).get("Authorization")!, body: JSON.parse(String(init.body)) })
    return new Response('data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n', { headers: { "Content-Type": "text/event-stream" } })
  })
  const resolved = await f.runtime.resolveModel({}); expect(resolved.status).toBe("ready")
  if (resolved.status !== "ready") throw new Error("no binding")
  for await (const _event of resolved.binding.client.stream({ systemPrompt: "test", messages: [{ role: "user", content: "hi" }], tools: [] })) {}
  f.codex.token.mockResolvedValue({ accessToken: "access-two", accountId: "workspace-a" })
  for await (const _event of resolved.binding.client.stream({ systemPrompt: "test", messages: [{ role: "user", content: "again" }], tools: [] })) {}
  expect(requests.map(r => r.url)).toEqual(["https://chatgpt.com/backend-api/codex/responses", "https://chatgpt.com/backend-api/codex/responses"])
  expect(requests.map(r => r.token)).toEqual(["Bearer access-one", "Bearer access-two"])
  expect(requests[0]?.body.store).toBe(false)
})
it.each([{ baseURL: "https://untrusted.test" }, { modelsURL: "https://untrusted.test/models" }, { protocol: "openai-completions" }, { headers: { "x-credential": "value" } }, { apiKeyEnv: "OPENAI_API_KEY" }])("rejects unsafe plan route before resolving its token: %j", async extra => {
  const f = await fixture(extra)
  expect((await f.runtime.resolveModel({})).status).toBe("invalid")
  await expect(f.runtime.probeModels("plan")).rejects.toThrow(/ChatGPT/)
  expect(f.codex.token).not.toHaveBeenCalled()
})
it("rejects protocol override, audio and API-key fallback on a subscription route", async () => {
  const f = await fixture()
  expect((await f.runtime.resolveModel({ sessionSelection: { provider: "plan", model: "model-a", protocol: "openai-completions" } })).status).toBe("invalid")
  await expect(f.runtime.setVideoAudioModel!({ provider: "plan", model: "model-a" })).rejects.toThrow(/ChatGPT/)
  await expect(f.runtime.setApiKey("plan", "not-allowed")).rejects.toThrow(/ChatGPT/)
  expect(f.codex.token).not.toHaveBeenCalled()
})
it("refuses non-Responses protocol writes before persisting subscription provider or model settings", async () => {
  const f = await fixture()
  const before = JSON.stringify(f.settings.get().llm)
  await expect(f.runtime.setModel("plan", "model-a", { protocol: "anthropic-messages" })).rejects.toThrow(/Responses/)
  await expect(f.runtime.addModels("plan", [{ id: "unsafe", protocol: "openai-completions" }])).rejects.toThrow(/Responses/)
  await expect(f.runtime.patchProvider("plan", { protocol: "openai-completions" })).rejects.toThrow(/Responses/)
  await expect(f.runtime.upsertProvider("plan", { ...f.settings.get().llm.providers.plan!, models: [{ id: "unsafe", protocol: "gemini" }] })).rejects.toThrow(/Responses/)
  expect(JSON.stringify(f.settings.get().llm)).toBe(before)
  expect(f.codex.token).not.toHaveBeenCalled()
  const directory = await f.runtime.directory()
  expect(directory[0]?.oauthProvider).toBe("openai-codex")
  expect(directory[0]?.models[0]?.protocol).toBe("openai-responses")
})
it("replaces account model metadata, removes disappeared models and clears an empty catalog", async () => {
  const f = await fixture({ models: [{ id: "model-a", name: "Old name", contextWindow: 1000 }, { id: "removed" }], promptCache: { mode: "off" } })
  await f.runtime.replaceSubscriptionModels("plan", "account-a", [{ id: "model-a", name: "New name", contextWindow: 2000, inputModalities: ["text", "image"] }])
  expect(f.settings.get().llm.providers.plan?.models).toEqual([{ id: "model-a", name: "New name", contextWindow: 2000, inputModalities: ["text", "image"] }])
  expect(f.settings.get().llm.providers.plan?.promptCache).toEqual({ mode: "off" })
  await expect(f.runtime.replaceSubscriptionModels("plan", "another-account", [])).rejects.toThrow(/account/)
  await f.runtime.replaceSubscriptionModels("plan", "account-a", [])
  expect((await f.runtime.directory()).find(row => row.id === "plan")?.models).toEqual([])
  expect((await f.runtime.resolveModel({})).status).toBe("invalid")
  expect(f.codex.token).not.toHaveBeenCalled()
})
