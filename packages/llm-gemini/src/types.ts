import type { PromptCacheConfig } from "@i-harness/llm-seam"

export interface GeminiConfig {
  executionIdentity?: import("@i-harness/llm-seam").LiveExecutionIdentity
  apiKey: string
  baseUrl?: string
  model: string
  providerId?: string
  options?: Record<string, unknown>
  /** Only explicit off removes a manual cachedContent reference. */
  promptCache?: PromptCacheConfig
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping.
  inputModalities?: ("text" | "image")[]
  /** M59: literal extra request headers (gateway-required). The adapter's own
   * headers win on collision. */
  headers?: Record<string, string>
}
