import type { ProviderProfile, ProviderModelContext } from "../types.ts"
import { resolveModelCard } from "./resolve.ts"

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

// M31 T1 (M32 T1 fix): the settings-side user model row is the TOP of the
// unified chain — userModel > profile.modelContexts[modelId] >
// profile.contextWindow > model-catalog.json CARD > undefined. Pure, per-field:
// userModel.contextWindow overlaps the window chain; userModel.maxTokens is
// the OUTPUT-LENGTH cap (same semantics as the card's maxOutputTokens — M31
// G1's maxTokens→maxContextWindow mapping is REMOVED; maxContextWindow keeps
// its M15 native meaning). The card arm used to be called "value-only … it
// never provides a request default" — SUPERSEDED BY M72 Ⅱ (spec §1.1): the
// card's number IS the second source of the request's output cap, behind the
// user's row, and core-agent clamps the winner against the request's remaining
// room. What nothing here may do is CLAMP: a user number above the card stays
// as written, and travels as written. M72 Ⅱ (R5): the result is
// undefined only when NEITHER number resolved. Gating on the WINDOW alone was
// wrong on the chain's own terms — the user's setting is the FIRST source
// (spec §1.1) — and it silently dropped a row's `maxTokens` wherever no card
// and no window existed (every `openai`-family route is exactly that route).
// A resolution carrying only `maxOutputTokens` is therefore returned with
// `contextWindow` absent; window-only readers are unaffected — they read
// `.contextWindow`, absent in exactly the cases it always was — and callers
// needing only the card still use resolveModelCard.
export interface EffectiveContextInput {
  profile: ProviderProfile
  modelId: string
  /** Settings-side user model row (llm.providers.<route>.models[i]) — absent = no user override. */
  userModel?: { contextWindow?: number; maxTokens?: number }
}

/** The unified chain's resolution of one model. */
export interface EffectiveModelContext {
  contextWindow?: number
  maxContextWindow?: number
  /** M32: model-documented output-length cap (card / user maxTokens override). */
  maxOutputTokens?: number
}

export function resolveEffectiveModelContext(input: EffectiveContextInput): EffectiveModelContext | undefined {
  const base = resolveModelContext(input.profile, input.modelId)
  // The declared family, else the route name. NOT derived from the base URL:
  // a derivation would guess wrong on exactly the set-ups the field exists for
  // (gateways, proxies, regional/subscription variants), and a wrong family is
  // worse than none — it supplies ANOTHER vendor's numbers.
  const card = resolveModelCard(input.profile.catalog ?? input.profile.name, input.modelId)
  const merged: EffectiveModelContext = {
    ...base,
    ...(card !== undefined ? { maxOutputTokens: card.maxOutputTokens } : {}),
  }
  // CARD arm: contextWindow falls through to the card only when no profile/
  // modelContexts tier provided one (per-field — card never overwrites).
  if (merged.contextWindow === undefined && card?.contextWindow !== undefined) {
    merged.contextWindow = card.contextWindow
  }
  const user = input.userModel
  if (user?.contextWindow !== undefined) merged.contextWindow = user.contextWindow
  if (user?.maxTokens !== undefined) merged.maxOutputTokens = user.maxTokens
  return merged.contextWindow === undefined && merged.maxOutputTokens === undefined ? undefined : merged
}
