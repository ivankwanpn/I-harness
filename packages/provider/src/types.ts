import type { ModelWaitPolicy, PromptCacheConfig, RetryPolicyConfig } from "@i-harness/llm-seam"
// Type-only: the per-row protocol is the SAME closed set settings validates
// (`SettingsProviderProtocol`) — a fourth copy of the five names would be a
// fourth place to edit one enum. Erased at build time, so no runtime edge.
import type { SettingsProviderProtocol } from "@i-harness/settings"

export type ProviderProtocol = "openai-responses" | "openai-compatible" | "anthropic-messages" | "gemini" | "bedrock"

export interface ProviderModelContext {
  contextWindow?: number
  maxContextWindow?: number
}

export interface ProviderProfile {
  name: string
  /** The model-card FAMILY this route's per-model metadata comes from — a key
   * of `model-catalog.json`'s `families` (`deepseek`, `gemini`, …).
   *
   * `name` is the ROUTE identity: it keys the registry and appears as the
   * directory route, and it is the user's label. A user who opens a SECOND route
   * for one vendor (`deepseek1`, for a second API key) therefore has a name that
   * is not the vendor's, and before this field that route resolved no model
   * metadata at all. Absent → the route name, which is the status quo for the
   * common case where a route IS named after its vendor. */
  catalog?: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKey?: string
  /** Internal account-bound route; never persisted as a bearer credential. */
  codexSubscription?: boolean
  resolveCodexAuth?: (signal?: AbortSignal) => Promise<{ accessToken: string; accountId: string }>
  /** Task 3: credential-ref name of the route's default API key env (e.g.
   * `DEEPSEEK_API_KEY`). Surfaces as DirectoryEntry.defaultApiKeyEnv — the
   * runtime directory is the registry, so the profile is the single source. */
  apiKeyEnv?: string
  models?: string[]
  defaultModel?: string
  inputModalities?: ("text" | "image")[] // M14: absent = text-only (negative capability)
  /** M72 Ⅱ: which wire field THIS route's `openai-compatible` requests carry
   * the output cap on — `max_tokens` (the compatible-gateway spelling, and the
   * adapter's default when this is absent) or `max_completion_tokens` (what the
   * newest OpenAI models demand; `max_tokens` is rejected there as a legacy
   * name). Read by the openai-compatible adapter only — every other protocol
   * owns a single fixed spelling (llm-openai: `max_output_tokens`,
   * llm-anthropic: required `max_tokens`). */
  maxTokensField?: "max_tokens" | "max_completion_tokens"
  /** M72 Ⅲ: whether THIS route's `openai-compatible` requests ask the gateway
   * for usage (`stream_options.include_usage`). Absent = the adapter's own
   * default, which is ON (a routing default, not a capability probe); `false` =
   * the route's gateway rejects the key, and then NOTHING is sent. Read by the
   * openai-compatible adapter only — it is the one protocol of the five that
   * reports usage solely on request. */
  usageInStream?: boolean
  promptCache?: PromptCacheConfig
  contextWindow?: number                // M15: default window (tokens) for this provider
  maxContextWindow?: number             // M15: absolute ceiling; budget-enforcement hook (no enforcement in M15)
  modelContexts?: Record<string, ProviderModelContext> // M15: per-model overrides
  /** M59: literal extra request headers (gateways requiring a custom header —
   * e.g. OpenCode Zen's `x-opencode-session`). Merged into every adapter's
   * request headers; secrets belong in apiKey/apiKeyEnv, not here. */
  headers?: Record<string, string>
  modelWait?: ModelWaitPolicy // Host-only, opt-in for standalone builders.
  retryPolicy?: RetryPolicyConfig       // M20: retry settings; absent = no retries (validated at registration)
}

// ── Task 3 (models plan D3): the registry IS the directory ───────────────────
// describeDirectory() is a view over the profiles registered through the
// existing register() — no second registration mechanism exists. probeModels()
// dispatches per route: a route probe (registerProbe) wins; an explicit draft
// baseURL (task 7 — D4) runs the generic discovery probe for ANY route; the
// built-in openai-compatible route probe comes next (its route-based preview
// flow), then the profile's static `models` catalog; a route with neither
// throws ProbeUnavailableError.

/** One discoverable model (probe results / static catalog rows). */
export interface ModelDescriptor {
  id: string
  inputModalities?: ("text" | "image")[]
  name?: string
  /** Discovered context window (tokens) — probe-normalized, positive ints only. */
  contextWindow?: number
  /** Discovered response cap (maxTokens / the limit.output half of a pair). */
  maxTokens?: number
  /** The row's OWN wire protocol, when it declares one — a settings model row
   * may override its route's protocol (provider-runtime's `resolveModel` reads
   * it as runtimeProfile's `modelProtocol`). `mergeModels` already spreads the
   * settings row, so the value is present at runtime; this only names it.
   * Probe results never carry it (a probe reports what an endpoint offers, and
   * the endpoint's protocol is the route's). */
  protocol?: SettingsProviderProtocol
}

/** Directory row: the UI-facing view of one registered provider route. */
export interface DirectoryEntry {
  route: string
  displayName: string
  protocol: string
  /** Credential-ref name of the route's default API key env (profile.apiKeyEnv). */
  defaultApiKeyEnv?: string
  defaultModel?: string
  /** Static catalog declared by the route's profile, when it has one. */
  models?: ModelDescriptor[]
}

/** A probe request carries an UNSAVED draft (URL/auth fields the user just
 * typed — nothing is stored by probing); omitted fields fall back to the
 * registered profile's own values. An explicit `modelsURL` is a full endpoint
 * and is fetched exactly once. An explicit `baseURL` is a host root and keeps
 * the ordered candidate strategy. `protocol` is the route's RESOLVED wire
 * protocol — the caller runs settings' resolveProviderProtocol chain (user >
 * SEEDED_PROTOCOLS) and REFUSES when it runs out (provider-runtime's
 * probeModels no longer passes the absent case down); this module's generic
 * terminal fallback (openai-completions = Bearer) therefore only serves
 * requests that name no protocol at all. Either explicit
 * URL makes the generic builtin probe run for ANY route (task 7 — D4: the
 * route-gate applies to the route-based preview flow only). */
export interface ProbeRequest {
  signal?: AbortSignal
  baseURL?: string
  modelsURL?: string
  apiKey?: string
  protocol?: string
  /** M60 E: literal extra request headers the route configures (a gateway
   * requiring e.g. `x-opencode-session`). The adapter's own auth headers win
   * on collision — see createBuiltinProbe. */
  headers?: Record<string, string>
}

export type Probe = (req: ProbeRequest) => Promise<ModelDescriptor[]>

export interface ProviderRegistry {
  register(profile: ProviderProfile): void
  get(name: string): ProviderProfile | undefined
  list(): ProviderProfile[]
  remove(name: string): void
  describeDirectory(): DirectoryEntry[]
  /** Per-route probe; re-registering a route replaces its previous probe. */
  registerProbe(route: string, probe: Probe): void
  probeModels(route: string, req: ProbeRequest): Promise<ModelDescriptor[]>
}

/** The adapter inputs, protocol-independent — the shared shape of all three
 * client factories (llm-openai-compatible / llm-openai / llm-anthropic). */
export interface WireClientConfig {
  apiKey: string
  baseUrl?: string
  model: string
  options?: Record<string, unknown>
  inputModalities?: ("text" | "image")[]
  /** M72 Ⅱ: the route's chosen output-cap field name (openai-compatible only;
   * absent → the adapter's `max_tokens` default). */
  maxTokensField?: "max_tokens" | "max_completion_tokens"
  /** M72 Ⅲ: the route's usage ask (openai-compatible only; absent → the
   * adapter's default, ON). */
  usageInStream?: boolean
  promptCache?: PromptCacheConfig
  /** M59: literal extra request headers merged into every request. */
  headers?: Record<string, string>
}
