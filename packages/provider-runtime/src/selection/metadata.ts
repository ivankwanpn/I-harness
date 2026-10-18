import { createHash } from "node:crypto"
import { resolveEffectiveModelContextEvidence } from "@i-harness/provider"
import { ANTHROPIC_MAX_TOKENS_FALLBACK, describeRouteBudgetCapability, type ModelBudgetBinding } from "@i-harness/llm-seam"
import type { ContextBindingMetadata } from "@i-harness/core-session"
import type { SettingsStoreSurface } from "@i-harness/settings"
import type { ProviderView } from "../directory/types.ts"
import { runtimeProfile } from "../directory/profile.ts"
import { normalizeReasoningEffort, selectModel } from "./choice.ts"
import type { ProviderRuntime } from "../types.ts"

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
/** Same effective profile/context fold used by execution, with no auth/client/UI work. */
export function describeSelection(settings: SettingsStoreSurface, provider: (id: string) => ProviderView | undefined, input: Parameters<ProviderRuntime["resolveModel"]>[0]) {
  const selection = selectModel(input, settings.get().llm.defaultModel)
  if ("state" in selection) return undefined
  const view = provider(selection.providerId)
  if (!view) return undefined
  const userModel = view.user?.models?.find(row => row.id === selection.modelId)
  const listed = view.models.find(row => row.id === selection.modelId)
  const modalities = userModel?.inputModalities ?? listed?.inputModalities ?? (listed ? view.inputModalities : undefined)
  const profile = runtimeProfile(view, undefined, modalities, selection.protocol ?? userModel?.protocol, settings.get().modelRetryLimit)
  if (!profile) return undefined
  if (view.user?.oauthAccountId) {
    profile.codexSubscription = true
    profile.baseUrl = "https://chatgpt.com/backend-api/codex"
  }
  if (profile.codexSubscription && profile.protocol !== "openai-responses") return undefined
  const effective = resolveEffectiveModelContextEvidence({ profile, modelId: selection.modelId, ...(userModel ? { userModel } : {}) })
  const limits = effective?.limits ?? {}
  const generation: ModelBudgetBinding["generation"] = effective?.generation.outputCap ? effective.generation
    : profile.protocol === "anthropic-messages" ? { origin: "adapter-default", outputCap: { value: ANTHROPIC_MAX_TOKENS_FALLBACK, origin: "adapter-default", sourceId: "anthropic-fallback-v1" } }
    : { origin: profile.codexSubscription ? "provider-managed" : "unspecified" }
  const capability = describeRouteBudgetCapability(profile)
  const contextWindow = limits.contextTokens?.value
  const maxOutputTokens = generation.outputCap?.value
  const reasoningEffort = normalizeReasoningEffort(selection.reasoningEffort)
  if (selection.reasoningEffort !== undefined && reasoningEffort === undefined) return undefined
  // Unknown header values/account affinity/opaque options are never equality evidence.
  // Exclude credentials/transport secrets before hashing; partial identity refuses restore.
  let partial = !!view.headers && Object.keys(view.headers).length > 0 || !!view.user?.oauthAccountId
  let endpoint = profile.baseUrl
  if (endpoint) {
    try { const url = new URL(endpoint); if (url.username || url.password || url.search || url.hash) { partial = true; endpoint = undefined } }
    catch { partial = true; endpoint = undefined }
  }
  const known = new Set(["name", "displayName", "protocol", "baseUrl", "apiKey", "apiKeyEnv", "headers", "retryPolicy", "modelWait", "resolveCodexAuth", "codexSubscription", "models", "defaultModel", "catalog", "inputModalities", "maxTokensField", "usageInStream", "promptCache", "contextWindow", "maxContextWindow", "modelContexts"])
  // Nonstandard profile/options fields have no trusted non-secret schema.
  // Withhold equality evidence rather than hash a sensitive opaque value.
  if (Object.keys(profile).some(key => !known.has(key))) partial = true
  const content = { schema: 1, provider: selection.providerId, model: selection.modelId, protocol: profile.codexSubscription ? "openai-responses-subscription" : profile.protocol,
    endpoint, catalog: profile.catalog, contextWindow, maxOutputTokens, reasoningEffort, inputModalities: profile.inputModalities,
    maxTokensField: profile.maxTokensField, usageInStream: profile.usageInStream, promptCache: profile.promptCache,
    limits, generation, capability }
  const metadata: ContextBindingMetadata = { version: 1, providerId: selection.providerId, modelId: selection.modelId, protocol: content.protocol,
    ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}), ...(reasoningEffort ? { reasoningEffort } : {}),
    identityCoverage: partial ? "partial" : "complete",
    ...(partial ? {} : { bindingConfigFingerprint: createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex") }) }
  const budgetBinding: ModelBudgetBinding = { version: 1, metadata, limits, generation, capability, capacityDomain: { kind: 'unknown', reason: 'coupling-unverified' }, ...(reasoningEffort ? { reasoningEffort } : {}) }
  return { selection, view, profile, metadata, budgetBinding }
}
