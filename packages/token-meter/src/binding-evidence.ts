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
export interface GenerationPolicy {
  readonly outputCap?: NumericEvidence
  readonly origin: "explicit" | "configured" | "legacy-catalog-default" | "adapter-default" | "provider-managed" | "unspecified"
}
