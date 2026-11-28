/** Sourced numeric facts, separate from the request's generation preference. */
export type EvidenceOrigin = "configured-model-row" | "profile-model" | "profile" | "catalog" | "adapter-default" | "explicit-route" | "explicit-request"
export interface NumericEvidence {
  readonly value: number
  readonly origin: EvidenceOrigin
  /** A bounded producer/revision label; never transport configuration. */
  readonly sourceId: string
}
export interface ModelLimits {
  readonly contextTokens?: NumericEvidence
  readonly contextCeilingTokens?: NumericEvidence
  readonly inputTokens?: NumericEvidence
  readonly outputTokens?: NumericEvidence
  readonly bodyBytes?: NumericEvidence
}

/** Upper bound for model input before generation reserves or safety margins. */
export function inputCapacityCeiling(contextWindow: number | undefined, limits?: ModelLimits): number | undefined {
  const window = contextWindow ?? limits?.contextTokens?.value
  const input = limits?.inputTokens?.value
  if (window === undefined) return input
  return input === undefined ? window : Math.min(window, input)
}
export interface GenerationPolicy {
  readonly outputCap?: NumericEvidence
  readonly origin: "explicit" | "configured" | "legacy-catalog-default" | "adapter-default" | "provider-managed" | "unspecified"
}

/** Numeric provenance does not establish provider input/output coupling. */
export type CapacityDomain = 'shared-context' | 'input-only'
export type UnknownReason = import('@i-harness/core-session').AdmissionUnknownReason
export type UnknownFact = { readonly kind: 'unknown'; readonly reason: UnknownReason }
export type Sourced<T> = { readonly kind: 'known'; readonly value: T; readonly sourceId: string } | UnknownFact
