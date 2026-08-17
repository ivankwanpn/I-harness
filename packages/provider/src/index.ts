import type { ModelClient } from "@i-harness/llm-seam"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import { createAnthropicClient } from "@i-harness/llm-anthropic"

export type ProviderProtocol = "openai-responses" | "openai-compatible" | "anthropic-messages"

export interface ProviderProfile {
  name: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKey?: string
  models?: string[]
}

export interface ProviderRegistry {
  register(profile: ProviderProfile): void
  get(name: string): ProviderProfile | undefined
  list(): ProviderProfile[]
  remove(name: string): void
}

export function createProviderRegistry(): ProviderRegistry {
  const profiles = new Map<string, ProviderProfile>()
  return {
    register(profile) {
      if (profiles.has(profile.name)) throw new Error(`duplicate provider: ${profile.name}`)
      profiles.set(profile.name, profile)
    },
    get(name) { return profiles.get(name) },
    list() { return [...profiles.values()] },
    remove(name) { profiles.delete(name) },
  }
}

// Builds a ModelClient by dispatching on the provider's protocol. extra is
// passed through for model-end options (e.g. reasoning_effort); unknown
// protocols error here, and bad models error at the model end.
export function buildModelClient(profile: ProviderProfile, model: string, _extra?: Record<string, unknown>): ModelClient {
  switch (profile.protocol) {
    case "openai-responses":
      return createOpenAIClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model })
    case "openai-compatible":
      return createOpenAICompatibleClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model })
    case "anthropic-messages":
      return createAnthropicClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model })
    default:
      throw new Error(`unknown provider protocol: ${String((profile as { protocol?: unknown }).protocol)}`)
  }
}
