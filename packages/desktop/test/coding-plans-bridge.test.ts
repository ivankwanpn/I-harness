import { expect, it, vi } from "vitest"
import { createGlobalProviderSettings } from "../src/main/global-provider-settings.ts"

const state = { accounts: [], welcomePending: false }
it("opens OAuth only in main and returns public state rather than the authorization URL", async () => {
  const request = vi.fn(async (method: string) => method.endsWith("/start") ? { authorizationUrl: "https://auth.openai.com/codex/device" } : state)
  const open = vi.fn(async (_url: string) => {})
  const service = createGlobalProviderSettings(async () => ({ request }), { openExternal: open })
  expect(await service.request({ kind: "desktop/coding-plans/start" })).toEqual(state)
  expect(open).toHaveBeenCalledWith("https://auth.openai.com/codex/device")
  await service.close()
})
it("rejects authorization redirects outside the fixed OpenAI endpoint", async () => {
  const request = vi.fn(async () => ({ authorizationUrl: "https://untrusted.test/steal" }))
  const open = vi.fn(async (_url: string) => {})
  const service = createGlobalProviderSettings(async () => ({ request }), { openExternal: open })
  await expect(service.request({ kind: "desktop/coding-plans/start" })).rejects.toThrow()
  expect(open).not.toHaveBeenCalled()
  await service.close()
})
it("rejects the retired external usage-page action without opening a browser", async () => {
  const open = vi.fn(async (_url: string) => {})
  const service = createGlobalProviderSettings(async () => ({ request: vi.fn(async () => state) }), { openExternal: open })
  await expect(service.request({ kind: "desktop/coding-plans/manage-usage" })).rejects.toThrow()
  expect(open).not.toHaveBeenCalled()
  await expect(service.request({ kind: "desktop/coding-plans/unknown" })).rejects.toThrow()
  await service.close()
})
it("rejects missing reset confirmation and refuses a different OpenAI authorization route", async () => {
  const open = vi.fn(async (_url: string) => {})
  const service = createGlobalProviderSettings(async () => ({ request: vi.fn(async () => ({ authorizationUrl: "https://auth.openai.com/api/accounts/authorize" })) }), { openExternal: open })
  await expect(service.request({ kind: "desktop/coding-plans/start" })).rejects.toThrow()
  expect(open).not.toHaveBeenCalled()
  await expect(service.request({ kind: "desktop/coding-plans/reset-credit", accountId: "a", creditId: "c" })).rejects.toThrow()
  await service.close()
})
