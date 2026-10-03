import { describe, expect, it } from "vitest"
import { createGlobalProviderSettings } from "../src/main/global-provider-settings.ts"

describe("global provider setup without a selected workspace", () => {
  it("routes directory and persistence commands to the dedicated configuration runtime", async () => {
    const calls: unknown[] = []
    const settings = createGlobalProviderSettings(async () => ({ request: async (method: string, params: unknown) => { calls.push({ method, params }); return { ok: true } } }))
    await settings.request({ kind: "desktop/global-provider/directory" })
    await settings.request({ kind: "desktop/global-provider/mutate", command: { action: "model/add", id: "local", model: "model-a", fields: { protocol: "openai-responses" } } })
    expect(calls).toEqual([
      { method: "desktop/provider/directory", params: {} },
      { method: "desktop/provider/mutate", params: { action: "model/add", id: "local", model: "model-a", fields: { protocol: "openai-responses" } } },
    ])
  })
  it("does not start a runtime for unknown operations or malformed probe identifiers", async () => {
    let started = 0
    const settings = createGlobalProviderSettings(async () => { started++; return { request: async () => null } })
    await expect(settings.request({ kind: "session/prompt", prompt: "do work" })).rejects.toThrow(/provider/i)
    await expect(settings.request({ kind: "desktop/global-provider/probe", id: "../outside", token: "x" })).rejects.toThrow(/provider/i)
    expect(started).toBe(0)
  })
})
