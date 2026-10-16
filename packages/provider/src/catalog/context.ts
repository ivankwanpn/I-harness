import type { ProviderProfile, ProviderModelContext } from "../types.ts"
import type { NumericEvidence, ModelLimits, GenerationPolicy } from "@i-harness/token-meter"
import { resolveModelCard, resolveModelCatalogProvenance } from "./resolve.ts"

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

// One evidence resolver owns per-field precedence. Legacy scalar properties are
// retained on its result while runtime aliases transition to the descriptor.
// Stored rows are configuration evidence, including rows written by refresh.
interface EffectiveContextInput {
  profile: ProviderProfile
  modelId: string
  /** Stored model row (llm.providers.<route>.models[i]), also written by refresh. */
  userModel?: { contextWindow?: number; maxTokens?: number }
}

/** The unified chain's resolution of one model. */
interface EffectiveModelContext {
  contextWindow?: number
  maxContextWindow?: number
  /** Legacy selected generation cap (stored row > catalog). */
  maxOutputTokens?: number
}

export interface ResolvedModelContextEvidence extends EffectiveModelContext {
  readonly limits: ModelLimits
  readonly generation: GenerationPolicy
}

function numeric(value: number | undefined, origin: NumericEvidence["origin"], sourceId: string): NumericEvidence | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("model budget evidence must be a positive safe integer")
  if (sourceId.length > 256 || !/^[a-zA-Z0-9:._-]+$/.test(sourceId)) throw new Error("invalid model budget source ID")
  return { value, origin, sourceId }
}

/** One per-field resolution; a stored row does not authenticate human intent. */
export function resolveEffectiveModelContextEvidence(input: EffectiveContextInput): ResolvedModelContextEvidence | undefined {
  const { profile, modelId, userModel } = input
  const override = profile.modelContexts?.[modelId]
  const family = profile.catalog ?? profile.name
  const card = resolveModelCard(family, modelId)
  const revision = card ? resolveModelCatalogProvenance().generatedAt : undefined
  const catalogSource = `catalog:${family}:${revision}`
  const contextTokens = userModel?.contextWindow !== undefined ? numeric(userModel.contextWindow, "configured-model-row", "settings-model-row-v1")
    : override?.contextWindow !== undefined ? numeric(override.contextWindow, "profile-model", "profile-model-v1")
    : profile.contextWindow !== undefined ? numeric(profile.contextWindow, "profile", "profile-v1")
    : numeric(card?.contextWindow, "catalog", catalogSource)
  const contextCeilingTokens = override?.maxContextWindow !== undefined ? numeric(override.maxContextWindow, "profile-model", "profile-model-v1")
    : numeric(profile.maxContextWindow, "profile", "profile-v1")
  const outputTokens = numeric(card?.maxOutputTokens, "catalog", catalogSource)
  const configured = numeric(userModel?.maxTokens, "configured-model-row", "settings-model-row-v1")
  const outputCap = configured ?? outputTokens
  const limits: ModelLimits = { ...(contextTokens ? { contextTokens } : {}), ...(contextCeilingTokens ? { contextCeilingTokens } : {}), ...(outputTokens ? { outputTokens } : {}) }
  if (!contextTokens && !contextCeilingTokens && !outputCap) return undefined
  return { contextWindow: contextTokens?.value, maxContextWindow: contextCeilingTokens?.value,
    ...(card || configured ? { maxOutputTokens: outputCap?.value } : {}), limits,
    generation: { origin: configured ? "configured" : outputTokens ? "legacy-catalog-default" : "unspecified", ...(outputCap ? { outputCap } : {}) } }
}
