import { resolveRetryPolicy, type RetryPolicyConfig } from "@i-harness/llm-seam"
import type { ProviderProfile } from "../types.ts"

// The three standalone wrappers that used to live here — `describeDirectory()`,
// `registerProbe(route, probe)` and `probeModels(route, req)` — were removed.
// Each was a one-line sugar over `defaultProviderRegistry()` plus the equivalent
// INSTANCE method, which remains: `defaultProviderRegistry().probeModels(…)`.
//
// Why they went: production never called them (measured — no file outside this
// package and its own test file did), and the comment above already gives the
// reason they were the wrong shape: "Embeddings that own a specific registry
// should pass it through its methods instead". A second way to do one thing is
// what this package's own advice argues against.
//
// One instrument note, because it is why only two of the three were ever rows:
// `probeModels` was NOT reported, because the scanner's used-test is a TEXT match
// and `packages/provider-runtime/src/index.ts:262` writes
// `registry.probeModels(id, …)` — the INSTANCE method. A word regex cannot tell
// `probeModels(…)` from `registry.probeModels(…)`, so the standalone read as used.

// M15: context windows fail loud at registration (no defaults injected —
// absence means "unknown, fall back to config").
function validateWindow(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`provider: ${label} must be a positive integer (got ${value})`)
  }
}

export function validateModelContext(profile: ProviderProfile): void {
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
export function validateRetryPolicy(policy: RetryPolicyConfig | undefined): void {
  resolveRetryPolicy(policy)
}
