import type { ProviderAuthResolver } from "@i-harness/credentials"
import type { CreateProviderRuntimeOptions } from "../types.ts"
import type { ProviderView } from "../directory/types.ts"
import { requestVideoAudio } from "../video-audio.ts"
import { canonicalLlm } from "../configuration/store.ts"
import { authRef, authValue } from "./auth.ts"
import type { ProviderRuntime } from "../types.ts"

export function createMediaRuntime(
  options: Pick<CreateProviderRuntimeOptions, "settings">,
  auth: ProviderAuthResolver,
  provider: (id: string) => ProviderView | undefined,
): Pick<ProviderRuntime, "setVideoAudioModel" | "analyzeVideoAudio"> {
  return {
    async setVideoAudioModel(selection) {
      if (selection !== null) {
        if (provider(selection.provider)?.user?.oauthAccountId) throw new Error("ChatGPT plan does not support direct audio input")
        if (!selection.provider.trim() || !selection.model.trim() || selection.model.length > 256) throw new Error("Invalid video audio model")
        const view = provider(selection.provider)
        if (!view || !["openai-completions", "openai-responses"].includes(view.protocol ?? "")) throw new Error("Select an OpenAI Chat-compatible provider for video audio")
      }
      const next = { ...canonicalLlm(options.settings) }
      if (selection) next.videoAudio = { provider: selection.provider, model: selection.model }
      else delete next.videoAudio
      await options.settings.set({ llm: next })
    },

    async analyzeVideoAudio(input) {
      input.signal?.throwIfAborted()
      const selection = options.settings.get().llm.videoAudio
      if (!selection) return { status: "unconfigured", reason: "Select a video audio model in Settings > Models and providers to analyze speech and sounds." }
      const view = provider(selection.provider)
      if (view?.user?.oauthAccountId) return { status: "unsupported", reason: "ChatGPT plan does not support direct audio input." }
      if (!view || !["openai-completions", "openai-responses"].includes(view.protocol ?? "")) return { status: "unsupported", reason: "The selected video audio provider must support OpenAI Chat audio input." }
      const ref = authRef(view)
      if (!ref || !view.baseURL) return { status: "unconfigured", reason: "Configure the video audio provider endpoint and API key." }
      try {
        const key = authValue(await auth.resolve(ref, { providerId: selection.provider, purpose: "inference", signal: input.signal }))
        input.signal?.throwIfAborted()
        if (!key) return { status: "unconfigured", reason: "Configure an API key for the selected video audio provider." }
        return await requestVideoAudio(input, { ...selection, baseURL: view.baseURL, apiKey: key, headers: view.headers })
      } catch {
        input.signal?.throwIfAborted()
        return { status: "failed", reason: "Unable to resolve the video audio provider credentials." }
      }
    }
  }
}
