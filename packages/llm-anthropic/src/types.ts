import type { PromptCacheConfig } from "@i-harness/llm-seam"

export interface AnthropicConfig {
  executionIdentity?: import("@i-harness/llm-seam").LiveExecutionIdentity
  apiKey: string
  baseUrl?: string
  model: string
  providerId?: string
  options?: Record<string, unknown>
  promptCache?: PromptCacheConfig
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping. Forwarded by
  // buildModelClient (Task 6).
  inputModalities?: ("text" | "image")[]
  /** M59: literal extra request headers (gateway-required). The adapter's own
   * headers win on collision. */
  headers?: Record<string, string>
}
