import { createWaitingGuard, createRetryingClient, resolveRetryPolicy, validatePromptCacheConfig, type ModelClient } from "@i-harness/llm-seam"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import { createAnthropicClient } from "@i-harness/llm-anthropic"
import { createGeminiClient } from "@i-harness/llm-gemini"
import { createBedrockClient } from "@i-harness/llm-bedrock"
import type { ProviderProfile } from "../types.ts"

// Builds a ModelClient by dispatching on the provider's protocol. extra is
// passed through to the model end as request-body options (e.g.
// reasoning_effort). When model is omitted, profile.defaultModel is used,
// falling back to "gpt-4o". Unknown protocols error here, and bad models
// error at the model end.
function buildClient(profile: ProviderProfile, model: string, extra?: Record<string, unknown>): ModelClient {
  if (profile.codexSubscription && profile.protocol !== "openai-responses") throw new Error("Codex subscription credentials require the Responses protocol")
  const headers = profile.headers
  validatePromptCacheConfig(profile.promptCache)
  switch (profile.protocol) {
    case "openai-responses":
      return createOpenAIClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, providerId: profile.name, executionIdentity: profile.executionIdentity, options: extra, inputModalities: profile.inputModalities, ...(profile.codexSubscription !== undefined ? { codexSubscription: profile.codexSubscription } : {}), ...(profile.resolveCodexAuth !== undefined ? { resolveCodexAuth: profile.resolveCodexAuth } : {}), ...(profile.promptCache !== undefined ? { promptCache: profile.promptCache } : {}), ...(headers !== undefined ? { headers } : {}) })
    case "openai-compatible":
      return createOpenAICompatibleClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, providerId: profile.name, executionIdentity: profile.executionIdentity, options: extra, inputModalities: profile.inputModalities, maxTokensField: profile.maxTokensField, usageInStream: profile.usageInStream, ...(profile.promptCache !== undefined ? { promptCache: profile.promptCache } : {}), ...(headers !== undefined ? { headers } : {}) })
    case "anthropic-messages":
      return createAnthropicClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, providerId: profile.name, executionIdentity: profile.executionIdentity, options: extra, inputModalities: profile.inputModalities, ...(profile.promptCache !== undefined ? { promptCache: profile.promptCache } : {}), ...(headers !== undefined ? { headers } : {}) })
    case "gemini":
      return createGeminiClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, providerId: profile.name, executionIdentity: profile.executionIdentity, options: extra, inputModalities: profile.inputModalities, ...(profile.promptCache !== undefined ? { promptCache: profile.promptCache } : {}), ...(headers !== undefined ? { headers } : {}) })
    case "bedrock":
      // No apiKey — the AWS credential chain (env / ~/.aws/credentials /
      // IMDS) resolves at the SDK client; region defaults from the env in the
      // adapter (AWS_REGION → us-east-1).
      return createBedrockClient({ model, providerId: profile.name, executionIdentity: profile.executionIdentity, options: extra, inputModalities: profile.inputModalities })
    default:
      throw new Error(`unknown provider protocol: ${String((profile as { protocol?: unknown }).protocol)}`)
  }
}

// M20: when profile.retryPolicy is set, the protocol client is wrapped with
// the retrying client; the policy was validated at registration (or here at
// build time, defensively — resolveRetryPolicy also throws). Absent policy,
// the unwrapped protocol client is returned as before.
export function buildModelClient(profile: ProviderProfile, model?: string, extra?: Record<string, unknown>): ModelClient {
  const resolved = model ?? profile.defaultModel ?? "gpt-4o"
  const raw = buildClient(profile, resolved, extra)
  const client = profile.modelWait ? createWaitingGuard(raw, profile.modelWait) : raw
  if (profile.retryPolicy === undefined) return client
  return createRetryingClient(client, resolveRetryPolicy(profile.retryPolicy), { providerId: profile.name, modelId: resolved })
}
