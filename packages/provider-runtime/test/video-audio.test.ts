import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsStore } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { createProviderRuntime } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "video-audio-"))
  const settings = new SettingsStore({ path: join(root, "settings.json") }); await settings.load()
  await settings.set({ llm: { providers: { audio: { protocol: "openai-responses", baseURL: "https://audio.invalid/v1", apiKeyEnv: "TEST_AUDIO" } }, defaultModel: { provider: "", model: "" } } })
  const credentials = createCredentialStore(join(root, "credentials.json"))
  await credentials.set("TEST_AUDIO", "test-key")
  const runtime = createProviderRuntime({ settings, credentials })
  return { runtime, settings }
}
it("does not upload audio without an explicit selected audio model", async () => {
  const { runtime } = await fixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch)
  expect(await runtime.analyzeVideoAudio!({ wav: new Uint8Array(44), startSeconds: 0, durationSeconds: 1 })).toMatchObject({ status: "unconfigured" })
  expect(fetch).not.toHaveBeenCalled()
})
it("uses the selected audio route for speech and sounds and preserves it through unrelated edits", async () => {
  const { runtime, settings } = await fixture()
  await runtime.setVideoAudioModel!({ provider: "audio", model: "audio-model" })
  await runtime.patchProvider("audio", { displayName: "Audio service" })
  const llm = settings.get().llm
  await settings.set({ llm: { ...llm, providers: { ...llm.providers, audio: { ...llm.providers.audio, headers: { authorization: "stale", "content-type": "text/plain", "x-test": "preserved" } } } } })
  await settings.load()
  expect(settings.get().llm.videoAudio).toEqual({ provider: "audio", model: "audio-model" })
  let body: any
  const fetch = vi.fn(async (url, init) => { body = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: "[00:00] Door closes; speaker says hello." } }] }) })
  vi.stubGlobal("fetch", fetch)
  expect(await runtime.analyzeVideoAudio!({ wav: new Uint8Array(44), startSeconds: 2, durationSeconds: 1 })).toMatchObject({ status: "analyzed", model: "audio-model" })
  expect(fetch.mock.calls[0]?.[0]).toBe("https://audio.invalid/v1/chat/completions"); expect(body.model).toBe("audio-model"); expect(body.modalities).toEqual(["text"])
  expect(body.messages[1].content[1].input_audio.format).toBe("wav")
  const headers = new Headers(fetch.mock.calls[0]?.[1].headers)
  expect(headers.get("authorization")).toBe("Bearer test-key")
  expect(headers.get("content-type")).toBe("application/json")
  expect(headers.get("x-test")).toBe("preserved")
  expect((await runtime.directory()).find(row => row.id === "audio")?.videoAudioModel).toBe("audio-model")
})
it("propagates cancellation and redacts provider error bodies", async () => {
  const { runtime } = await fixture(); await runtime.setVideoAudioModel!({ provider: "audio", model: "audio-model" })
  vi.stubGlobal("fetch", async () => new Response("secret echo", { status: 400 }))
  const input = { wav: new Uint8Array(44), startSeconds: 0, durationSeconds: 1 }
  const result = await runtime.analyzeVideoAudio!(input)
  expect(result).toMatchObject({ status: "failed" }); expect(JSON.stringify(result)).not.toContain("secret echo")
  await expect(runtime.analyzeVideoAudio!({ ...input, signal: AbortSignal.abort() })).rejects.toThrow()
})
