import { expect, it, vi } from "vitest"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import { providerCommand } from "../src/provider-wire.ts"

it("validates and routes the separate video audio selection", async () => {
  const setVideoAudioModel = vi.fn(async () => {})
  const runtime = { setVideoAudioModel } as unknown as ProviderRuntime
  await providerCommand(runtime, { action: "video-audio/set", id: "audio", model: "audio-model" })
  expect(setVideoAudioModel).toHaveBeenLastCalledWith({ provider: "audio", model: "audio-model" })
  await expect(providerCommand(runtime, { action: "video-audio/set", id: "audio", model: "" })).rejects.toThrow()
  await providerCommand(runtime, { action: "video-audio/set", id: "audio", model: null })
  expect(setVideoAudioModel).toHaveBeenLastCalledWith(null)
})

it("rejects malformed commands before invoking the runtime", async () => {
  const setModel = vi.fn()
  const runtime = { setModel } as unknown as ProviderRuntime
  await expect(providerCommand(runtime, { action: "model/edit", id: "route", model: "m", fields: { contextWindow: -1 } })).rejects.toThrow("positive integer")
  await expect(providerCommand(runtime, { action: "model/edit", id: "route", model: "m", fields: { apiKey: "secret" } })).rejects.toThrow("Unknown field")
  expect(setModel).not.toHaveBeenCalled()
})
it("preserves omitted values and explicit resets for individual models", async () => {
  const setModel = vi.fn().mockResolvedValue([])
  await providerCommand({ setModel } as unknown as ProviderRuntime, { action: "model/edit", id: "route", model: "m", fields: { contextWindow: 1000000, maxTokens: null } })
  expect(setModel).toHaveBeenCalledWith("route", "m", { contextWindow: 1000000, maxTokens: null })
})
it("accepts only declared text/image modality combinations", async () => {
  const setModel = vi.fn().mockResolvedValue([])
  const runtime = { setModel } as unknown as ProviderRuntime
  await providerCommand(runtime, { action: "model/edit", id: "route", model: "vision", fields: { inputModalities: ["text", "image"] } })
  expect(setModel).toHaveBeenCalledWith("route", "vision", { inputModalities: ["text", "image"] })
  await expect(providerCommand(runtime, { action: "model/edit", id: "route", model: "vision", fields: { inputModalities: ["image"] } })).rejects.toThrow()
})
it("does not allow a Desktop provider-level input-modality mutation", async () => {
  const createProvider = vi.fn()
  await expect(providerCommand({ createProvider } as unknown as ProviderRuntime, {
    action: "provider/create", id: "route", fields: { inputModalities: ["text", "image"] },
  })).rejects.toThrow("Unknown field")
  expect(createProvider).not.toHaveBeenCalled()
})
it("never includes API key material in validation errors or success responses", async () => {
  const setApiKey = vi.fn().mockResolvedValue(undefined)
  expect(await providerCommand({ setApiKey } as unknown as ProviderRuntime, { action: "key/set", id: "route", value: "fixture-secret" })).toEqual({ ok: true })
  expect(setApiKey).toHaveBeenCalledWith("route", "fixture-secret")
})
