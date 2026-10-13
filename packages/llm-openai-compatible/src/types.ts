import type { PromptCacheConfig } from "@i-harness/llm-seam"

export interface OpenAICompatibleConfig {
  apiKey: string
  /** Trusted per-client transport; absent uses the process fetch at call time. */
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  model: string
  providerId?: string
  options?: Record<string, unknown>
  /** Only explicit off removes manual controls; no cache keys are generated
   * for a Chat-compatible gateway by the automatic mode. */
  promptCache?: PromptCacheConfig
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping. Forwarded by
  // buildModelClient (Task 6).
  inputModalities?: ("text" | "image")[]
  /** M72 Ⅱ: which wire field carries the cap on THIS route. Default
   * `max_tokens` (the compatible-gateway spelling). */
  maxTokensField?: "max_tokens" | "max_completion_tokens"
  /** M72 Ⅲ: whether this route's requests ASK for usage
   * (`stream_options.include_usage`). Default `true` — this is the one protocol
   * of the five that reports usage only on request, so no other wire needs the
   * ask. `false` sends NOTHING (not `include_usage: false`): the switch exists
   * for a gateway that rejects the KEY, and such a gateway rejects it whatever
   * its value. A route-level capability flag — Pi's `supportsUsageInStreaming`. */
  usageInStream?: boolean
  /** M59: literal extra request headers (gateway-required, e.g. OpenCode
   * Zen's x-opencode-session). The adapter's own headers win on collision. */
  headers?: Record<string, string>
}
