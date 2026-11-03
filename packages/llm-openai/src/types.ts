import type { PromptCacheConfig } from "@i-harness/llm-seam"

export interface OpenAIConfig {
  executionIdentity?: import("@i-harness/llm-seam").LiveExecutionIdentity
  apiKey: string
  /** Account-bound Codex subscription requests use the Codex backend. */
  codexSubscription?: boolean
  /** Resolve immediately before each request, including retries and continuations. */
  resolveCodexAuth?: (signal?: AbortSignal) => Promise<{ accessToken: string; accountId: string; authEpoch?: string }>
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
