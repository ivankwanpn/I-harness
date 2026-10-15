import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { SettingsStore } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { createProviderRegistry } from "@i-harness/provider"
import { createProviderRuntime } from "../src/index.ts"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(protocol: "gemini" | "anthropic-messages" | "openai-responses", subscription = false) {
  const path = await mkdtemp(join(tmpdir(), "ih-r2a-runtime-")); roots.push(path)
  const settings = new SettingsStore({ path: join(path, "settings.json") }); await settings.load()
  await settings.set({ llm: { providers: { route: { protocol, models: [{ id: "unknown", contextWindow: 300_000, ...(protocol === "gemini" ? { maxTokens: 8000 } : {}) }], ...(subscription ? { oauthAccountId: "account-a", oauthProvider: "openai-codex" as const } : { apiKeyEnv: "SYNTHETIC" }) } }, defaultModel: { provider: "route", model: "unknown" } } })
  const build = vi.fn(() => ({ async *stream() { throw new Error("must not stream") } }))
  const auth = { async resolve() { return { kind: "api-key" as const, value: "controlled" } }, async describe() { return { configured: true, source: "env" as const, writable: false } } }
  const runtime = createProviderRuntime({ settings, credentials: createCredentialStore(join(path, "keys.json")), registry: createProviderRegistry(), buildClient: build, auth,
    ...(subscription ? { codex: { state: async () => ({ accountId: "account-a", status: "connected" }), token: async () => ({ accessToken: "controlled", accountId: "account-a" }), models: async () => [] } } : {}) })
  return { runtime, build }
}
it("projects runtime aliases from the same safe descriptor without requiring catalog membership", async () => {
  const { runtime } = await fixture("gemini")
  const state = await runtime.resolveModel({}); expect(state.status).toBe("ready")
  if (state.status !== "ready") throw new Error("no binding")
  expect(state.binding.budgetBinding).toMatchObject({ version: 1, metadata: state.binding.contextMetadata,
    limits: { contextTokens: { value: 300_000, origin: "configured-model-row" } },
    generation: { origin: "configured", outputCap: { value: 8000 } }, capability: { route: "gemini", outputParameter: "optional" } })
  expect(state.binding.contextWindow).toBe(300_000); expect(state.binding.maxOutputTokens).toBe(8000)
  expect(state.binding.budgetBinding?.limits.outputTokens).toBeUndefined()
  expect(JSON.stringify(state.binding.budgetBinding)).not.toMatch(/controlled|SYNTHETIC/)
})
it("marks Anthropic fallback as generation only without fabricating a provider output ceiling", async () => {
  const { runtime } = await fixture("anthropic-messages")
  const state = await runtime.resolveModel({}); if (state.status !== "ready") throw new Error(JSON.stringify(state))
  expect(state.binding.budgetBinding?.generation).toEqual({ origin: "adapter-default", outputCap: { value: 128000, origin: "adapter-default", sourceId: "anthropic-fallback-v1" } })
  expect(state.binding.budgetBinding?.limits.outputTokens).toBeUndefined()
  expect(state.binding.maxOutputTokens).toBe(128000)
})
it("attributes replacement subscription rows to stored configuration and keeps provider-managed output", async () => {
  const { runtime, build } = await fixture("openai-responses", true)
  await runtime.replaceSubscriptionModels("route", "account-a", [{ id: "unknown", contextWindow: 500_000 }])
  const described = await runtime.describeModelBindingMetadata!({}); expect(described?.contextWindow).toBe(500_000); expect(build).not.toHaveBeenCalled()
  const state = await runtime.resolveModel({}); if (state.status !== "ready") throw new Error(JSON.stringify(state))
  expect(state.binding.budgetBinding).toMatchObject({ limits: { contextTokens: { value: 500_000, origin: "configured-model-row" } }, generation: { origin: "provider-managed" }, capability: { outputParameter: "unsupported" } })
})
