import { createRetryingClient, resolveRetryPolicy, type ModelClient, type RetryPolicyConfig } from "@i-harness/llm-seam"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import { createAnthropicClient } from "@i-harness/llm-anthropic"

export type ProviderProtocol = "openai-responses" | "openai-compatible" | "anthropic-messages"

export interface ProviderModelContext {
  contextWindow?: number
  maxContextWindow?: number
}

export interface ProviderProfile {
  name: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKey?: string
  models?: string[]
  defaultModel?: string
  inputModalities?: ("text" | "image")[] // M14: absent = text-only (negative capability)
  contextWindow?: number                // M15: default window (tokens) for this provider
  maxContextWindow?: number             // M15: absolute ceiling; budget-enforcement hook (no enforcement in M15)
  modelContexts?: Record<string, ProviderModelContext> // M15: per-model overrides
  retryPolicy?: RetryPolicyConfig       // M20: retry settings; absent = no retries (validated at registration)
}

// M15: per-model override wins → profile-level → undefined. Pure; the values
// were already validated at registration, so no validation happens here.
export function resolveModelContext(
  profile: ProviderProfile,
  modelId: string,
): ProviderModelContext {
  const override = profile.modelContexts?.[modelId]
  return {
    contextWindow: override?.contextWindow ?? profile.contextWindow,
    maxContextWindow: override?.maxContextWindow ?? profile.maxContextWindow,
  }
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
      validateModelContext(profile)
      validateRetryPolicy(profile.retryPolicy) // M20: fail loud at registration on invalid retry config
      profiles.set(profile.name, profile)
    },
    get(name) { return profiles.get(name) },
    list() { return [...profiles.values()] },
    remove(name) { profiles.delete(name) },
  }
}

// M15: context windows fail loud at registration (no defaults injected —
// absence means "unknown, fall back to config").
function validateWindow(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`provider: ${label} must be a positive integer (got ${value})`)
  }
}

function validateModelContext(profile: ProviderProfile): void {
  if (profile.contextWindow !== undefined) validateWindow(profile.contextWindow, "contextWindow")
  if (profile.maxContextWindow !== undefined) validateWindow(profile.maxContextWindow, "maxContextWindow")
  if (profile.modelContexts) {
    for (const [modelId, mc] of Object.entries(profile.modelContexts)) {
      if (mc.contextWindow !== undefined) validateWindow(mc.contextWindow, `modelContexts["${modelId}"].contextWindow`)
      if (mc.maxContextWindow !== undefined) validateWindow(mc.maxContextWindow, `modelContexts["${modelId}"].maxContextWindow`)
    }
  }
}

// M20: delegate validation to llm-seam's resolver — it throws on invalid
// config (bad mode, non-positive delay, empty retryableCodes, …). Absent
// policy validates as "normal defaults", which is fine (register does not
// inject defaults; buildModelClient only wraps when retryPolicy is set).
function validateRetryPolicy(policy: RetryPolicyConfig | undefined): void {
  resolveRetryPolicy(policy)
}

// Builds a ModelClient by dispatching on the provider's protocol. extra is
// passed through to the model end as request-body options (e.g.
// reasoning_effort). When model is omitted, profile.defaultModel is used,
// falling back to "gpt-4o". Unknown protocols error here, and bad models
// error at the model end.
function buildClient(profile: ProviderProfile, model: string, extra?: Record<string, unknown>): ModelClient {
  switch (profile.protocol) {
    case "openai-responses":
      return createOpenAIClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, options: extra, inputModalities: profile.inputModalities })
    case "openai-compatible":
      return createOpenAICompatibleClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, options: extra, inputModalities: profile.inputModalities })
    case "anthropic-messages":
      return createAnthropicClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, options: extra, inputModalities: profile.inputModalities })
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
  const client = buildClient(profile, resolved, extra)
  if (profile.retryPolicy === undefined) return client
  return createRetryingClient(client, resolveRetryPolicy(profile.retryPolicy))
}
