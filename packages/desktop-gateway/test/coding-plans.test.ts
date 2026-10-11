import { expect, it, vi } from "vitest"
import { createCodingPlans } from "../src/coding-plans.ts"

function fixture(options: { now?: () => number } = {}) {
  const account = { accountId: "account-a", email: "person@example.test", status: "connected" as const, models: [{ id: "model-a", name: "Model A" }], availableCount: 1 }
  const accounts = { state: vi.fn(async () => account), start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), refresh: vi.fn(async () => {}), redeem: vi.fn(async () => {}), models: vi.fn(async () => account.models), token: vi.fn(), signOut: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const provider = { directory: vi.fn(async () => []), upsertProvider: vi.fn(async (_id: string, _config: unknown) => {}), replaceSubscriptionModels: vi.fn(async () => {}), setDefaultModel: vi.fn(async () => {}) }
  return { account, accounts, provider, controller: createCodingPlans(accounts as any, provider as any, options) }
}
it("synchronizes the account route without choosing a model from Coding Plans", async () => {
  const f = fixture()
  await f.controller.request("desktop/coding-plans/state", {})
  expect(f.provider.upsertProvider).toHaveBeenCalledWith(expect.stringMatching(/^codex-/), expect.objectContaining({ oauthAccountId: "account-a", oauthProvider: "openai-codex", protocol: "openai-responses", baseURL: "https://chatgpt.com/backend-api/codex" }))
  expect(f.provider.setDefaultModel).not.toHaveBeenCalled()
  expect(f.accounts.token).not.toHaveBeenCalled()
})
it("automatically reads allowance once, refreshes after the TTL, and never redeems a card", async () => {
  let now = 0
  const f = fixture({ now: () => now })
  await f.controller.request("desktop/coding-plans/state", {})
  expect(f.accounts.refresh).toHaveBeenCalledTimes(1)
  await f.controller.request("desktop/coding-plans/state", {})
  expect(f.accounts.refresh).toHaveBeenCalledTimes(1)
  now = 60001
  await f.controller.request("desktop/coding-plans/state", {})
  expect(f.accounts.refresh).toHaveBeenCalledTimes(2)
  expect(f.accounts.redeem).not.toHaveBeenCalled()
})
it("keeps the signed-in account visible when an automatic allowance request fails", async () => {
  const f = fixture()
  f.accounts.refresh.mockRejectedValue(new Error("fixture outage"))
  const result = await f.controller.request("desktop/coding-plans/state", {})
  expect(result).toMatchObject({ accounts: [{ id: "account-a", status: "connected" }] })
  await f.controller.request("desktop/coding-plans/state", {})
  expect(f.accounts.refresh).toHaveBeenCalledTimes(1)
})
it("does not overwrite model edits when the account page is opened", async () => {
  const f = fixture()
  await f.controller.request("desktop/coding-plans/state", {})
  const route = f.provider.upsertProvider.mock.calls[0]![0]
  f.provider.directory.mockResolvedValue([{ id: route, oauthAccountId: "account-a", models: [{ id: "model-a", name: "My name", contextWindow: 64000 }] }] as any)
  await f.controller.request("desktop/coding-plans/state", {})
  expect(f.provider.replaceSubscriptionModels).not.toHaveBeenCalled()
})
it.each([{ models: [{ id: "model-new", name: "Updated model", contextWindow: 256000, inputModalities: ["text", "image"] }] }, { models: [] }])("replaces the managed catalog including removed rows and empty results", async ({ models }) => {
  const f = fixture()
  f.accounts.models.mockResolvedValue(models as any)
  await f.controller.request("desktop/coding-plans/refresh", { accountId: "account-a" })
  expect(f.provider.replaceSubscriptionModels).toHaveBeenCalledWith(expect.stringMatching(/^codex-/), "account-a", models)
})
it("rejects unknown identities/models and malformed operations without changing default model", async () => {
  const f = fixture()
  await expect(f.controller.request("desktop/coding-plans/use-model", { accountId: "other", model: "model-a" })).rejects.toThrow()
  await expect(f.controller.request("desktop/coding-plans/use-model", { accountId: "account-a", model: "other" })).rejects.toThrow()
  await expect(f.controller.request("desktop/coding-plans/unknown", {})).rejects.toThrow()
  expect(f.provider.setDefaultModel).not.toHaveBeenCalled()
})
it("keeps browser authorization result separate from public state", async () => {
  const f = fixture()
  expect(await f.controller.request("desktop/coding-plans/start", {})).toEqual({ authorizationUrl: expect.stringContaining("auth.openai.com") })
  const state = await f.controller.request("desktop/coding-plans/state", {})
  expect(JSON.stringify(state)).not.toMatch(/authorizationUrl|access_token|refresh_token/)
})
it("uses the same Codex account for reset management and requires explicit confirmation", async () => {
  const f = fixture()
  await expect(f.controller.request("desktop/coding-plans/reset-credit", { accountId: "account-a", creditId: "card-a" })).rejects.toThrow()
  expect(f.accounts.redeem).not.toHaveBeenCalled()
  const result = await f.controller.request("desktop/coding-plans/reset-credit", { accountId: "account-a", creditId: "card-a", confirmed: true })
  expect(f.accounts.redeem).toHaveBeenCalledWith({ accountId: "account-a", creditId: "card-a", confirmed: true })
  expect(result).toMatchObject({ accounts: [{ id: "account-a" }], openaiManagement: { accountId: "account-a", availableCount: 1 } })
  expect(f.accounts.token).not.toHaveBeenCalled()
})
