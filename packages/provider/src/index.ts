import { createRetryingClient, resolveRetryPolicy, type ModelClient, type RetryPolicyConfig } from "@i-harness/llm-seam"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import { createAnthropicClient } from "@i-harness/llm-anthropic"
import { createGeminiClient } from "@i-harness/llm-gemini"
import { createBedrockClient } from "@i-harness/llm-bedrock"

export type ProviderProtocol = "openai-responses" | "openai-compatible" | "anthropic-messages" | "gemini" | "bedrock"

export interface ProviderModelContext {
  contextWindow?: number
  maxContextWindow?: number
}

export interface ProviderProfile {
  name: string
  displayName: string
  protocol: ProviderProtocol
  baseUrl?: string
  apiKey?: string
  /** Task 3: credential-ref name of the route's default API key env (e.g.
   * `DEEPSEEK_API_KEY`). Surfaces as DirectoryEntry.defaultApiKeyEnv — the
   * runtime directory is the registry, so the profile is the single source. */
  apiKeyEnv?: string
  models?: string[]
  defaultModel?: string
  inputModalities?: ("text" | "image")[] // M14: absent = text-only (negative capability)
  contextWindow?: number                // M15: default window (tokens) for this provider
  maxContextWindow?: number             // M15: absolute ceiling; budget-enforcement hook (no enforcement in M15)
  modelContexts?: Record<string, ProviderModelContext> // M15: per-model overrides
  retryPolicy?: RetryPolicyConfig       // M20: retry settings; absent = no retries (validated at registration)
}

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
  name?: string
  /** Discovered context window (tokens) — probe-normalized, positive ints only. */
  contextWindow?: number
  /** Discovered response cap (maxTokens / the limit.output half of a pair). */
  maxTokens?: number
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

/** A probe request carries an UNSAVED draft (baseURL/apiKey the user just
 * typed — nothing is stored by probing); omitted fields fall back to the
 * registered profile's own values. `protocol` is the route's RESOLVED wire
 * protocol — the caller runs settings' resolveProviderProtocol chain (user >
 * SEEDED_PROTOCOLS > DEFAULT) and passes it here; this module only applies
 * the generic terminal fallback (openai-completions = Bearer). AN EXPLICIT
 * draft baseURL makes the generic builtin probe run for ANY route (task 7 —
 * D4: the route-gate applies to the route-based preview flow only). */
export interface ProbeRequest {
  baseURL?: string
  apiKey?: string
  protocol?: string
}

export type Probe = (req: ProbeRequest) => Promise<ModelDescriptor[]>

/** No probe AND no static catalog for the route — probing is genuinely
 * unavailable (Task 4 maps this to the "model-probe-failed" 400 family). */
export class ProbeUnavailableError extends Error {
  readonly code = "probe-unavailable" as const
  readonly route: string
  constructor(route: string) {
    super(`no model probe available for route "${route}" (no probe registered, no static catalog)`)
    this.name = "ProbeUnavailableError"
    this.route = route
  }
}

/** Every in-flight probe failure is branded with this code — the symmetric
 * sibling of ProbeUnavailableError (Task 4 maps it to 400 model-probe-failed)
 * so a caller can tell "the probe exists but failed" from "no probe exists". */
export class ModelProbeFailedError extends Error {
  readonly code = "model-probe-failed" as const
  constructor(message: string) {
    super(message)
    this.name = "ModelProbeFailedError"
  }
}

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

/** Directory row for one profile — the registry's view, keyed to what the UI
 * needs. Runtime credentials (apiKey/baseUrl) NEVER surface here. */
function toDirectoryEntry(profile: ProviderProfile): DirectoryEntry {
  return {
    route: profile.name,
    displayName: profile.displayName,
    protocol: profile.protocol,
    ...(profile.apiKeyEnv !== undefined ? { defaultApiKeyEnv: profile.apiKeyEnv } : {}),
    ...(profile.defaultModel !== undefined ? { defaultModel: profile.defaultModel } : {}),
    ...(profile.models !== undefined && profile.models.length > 0
      ? { models: profile.models.map((id) => ({ id })) }
      : {}),
  }
}

/** Hard ceiling on one probe request — a black-hole/unroutable baseURL must
 * never hang the settings UI request (Task 4's POST /api/llm/probe). */
const PROBE_TIMEOUT_MS = 10_000
const OPENAI_COMPATIBLE_ROUTE = "openai-compatible"

/** Discovery candidates, tried in order (Task 2): the seed path first, then the
 * plain base path. The settings layer normalizes `/v1`-suffixed baseURLs away
 * (ROOT convention), so the two candidates are always distinct and the base
 * URL is always the host root. */
const PROBE_CANDIDATE_PATHS = ["/v1/models", "/models"] as const

/** Claude-compat base path suffixes (cc-switch's KNOWN_COMPAT_SUFFIXES): a
 * gateway that serves Claude's wire vocabulary under a sub-path (DeepSeek's
 * `https://api.deepseek.com/anthropic`, claude-code-proxy style `/api/coding`
 * etc.) usually exposes its REAL models endpoint at the STRIPPED ROOT —
 * `https://api.deepseek.com/v1/models`. The probe tries the suffixed base
 * first, then the stripped root, so both layouts are covered. */
const COMPAT_BASE_SUFFIXES = [
  "/anthropic",
  "/api/claudecode",
  "/api/anthropic",
  "/api/coding",
  "/claude",
  "/step_plan",
  "/apps/anthropic",
] as const

/** The root a compat-suffixed base strips to; the base itself when no known
 * suffix is present. */
function strippedBaseRoot(base: string): string {
  for (const suffix of COMPAT_BASE_SUFFIXES) {
    if (base.endsWith(suffix)) return base.slice(0, base.length - suffix.length)
  }
  return base
}

/**
 * The ordered candidate URLs for one normalized base: the base's own dual
 * candidates first ({base}/v1/models, {base}/models), then — when the base
 * ends with a known Claude-compat suffix — the STRIPPED ROOT's dual candidates
 * (root/v1/models, root/models), deduped. This is the candidate source for the
 * builtin probe; exported for the candidate-building contract.
 */
export function probeCandidatePaths(base: string): string[] {
  const root = strippedBaseRoot(base)
  const out: string[] = []
  for (const path of PROBE_CANDIDATE_PATHS) out.push(`${base}${path}`)
  if (root !== base) {
    for (const path of PROBE_CANDIDATE_PATHS) out.push(`${root}${path}`)
  }
  return [...new Set(out)]
}

/** Anthropic's wire API version (the same value the llm-anthropic adapter sends). */
const ANTHROPIC_API_VERSION = "2023-06-01"

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** Capacity values must be positive integers ("parse positive ints"): plain
 * numbers, or integer strings (e.g. "64000"); "100k"-style suffixes and
 * non-positive values are dropped — including the integer-string "0", which
 * parses to 0 and violates the positive contract. */
function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value)
    return n > 0 ? n : undefined
  }
  return undefined
}

/** Protocol-aware probe auth headers: anthropic-messages → x-api-key +
 * anthropic-version; gemini → x-goog-api-key; everything else (openai-
 * completions / openai-responses / bedrock / unknown) → Bearer. Key-less
 * probing is allowed (some gateways need no auth): an ABSENT key omits the
 * auth header entirely — never `Bearer undefined`. */
function probeAuthHeaders(protocol: string, apiKey: string | undefined): Record<string, string> {
  if (protocol === "anthropic-messages") {
    const headers: Record<string, string> = { "anthropic-version": ANTHROPIC_API_VERSION }
    if (apiKey !== undefined && apiKey !== "") headers["x-api-key"] = apiKey
    return headers
  }
  if (protocol === "gemini") {
    return apiKey !== undefined && apiKey !== "" ? { "x-goog-api-key": apiKey } : {}
  }
  return apiKey !== undefined && apiKey !== "" ? { Authorization: `Bearer ${apiKey}` } : {}
}

/** Capacity extraction (opencode-style model rows): top-level
 * contextWindow/maxTokens win per field; the `limit.{context,output}` pair is
 * atomic — a missing/invalid half drops BOTH (a half-pair never surfaces). */
function capacityOf(raw: Record<string, unknown>): { contextWindow?: number; maxTokens?: number } {
  const contextWindow = positiveInteger(raw.contextWindow)
  const maxTokens = positiveInteger(raw.maxTokens)
  const limit = isRecordLike(raw.limit) ? raw.limit : undefined
  const limitContext = limit !== undefined ? positiveInteger(limit.context) : undefined
  const limitOutput = limit !== undefined ? positiveInteger(limit.output) : undefined
  const pair = limitContext !== undefined && limitOutput !== undefined
    ? { contextWindow: limitContext, maxTokens: limitOutput }
    : undefined
  return {
    ...(contextWindow !== undefined ? { contextWindow } : pair !== undefined ? { contextWindow: pair.contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : pair !== undefined ? { maxTokens: pair.maxTokens } : {}),
  }
}

/** One normalized model row: id from id|slug|model|name (first present wins —
 * name doubles as the last-resort id); display name from
 * display_name|displayName|label|name. */
function toDescriptor(raw: Record<string, unknown>): ModelDescriptor | undefined {
  const id = nonEmptyString(raw.id) ?? nonEmptyString(raw.slug)
    ?? nonEmptyString(raw.model) ?? nonEmptyString(raw.name)
  if (id === undefined) return undefined
  const name = nonEmptyString(raw.display_name) ?? nonEmptyString(raw.displayName)
    ?? nonEmptyString(raw.label) ?? nonEmptyString(raw.name)
  return { id, ...(name !== undefined ? { name } : {}), ...capacityOf(raw) }
}

/** Array-form rows: an entry with no resolvable id is a hardened check — the
 * branded error never escapes as a bare TypeError (fix round 1). */
function normalizeRows(items: unknown[]): ModelDescriptor[] {
  return items.map((item): ModelDescriptor => {
    if (typeof item === "string" && item !== "") return { id: item }
    if (isRecordLike(item)) {
      const descriptor = toDescriptor(item)
      if (descriptor !== undefined) return descriptor
    }
    throw new ModelProbeFailedError("model probe failed: model entry missing id")
  })
}

/** Record-map form: id from the key, metadata from the value (string value =
 * display name; null/scalar = id-only row — lenient). */
function normalizeMap(map: Record<string, unknown>): ModelDescriptor[] {
  return Object.entries(map).map(([id, value]): ModelDescriptor => {
    if (value === null) return { id }
    if (typeof value === "string") return value !== "" ? { id, name: value } : { id }
    if (isRecordLike(value)) {
      const name = nonEmptyString(value.display_name) ?? nonEmptyString(value.displayName)
        ?? nonEmptyString(value.label) ?? nonEmptyString(value.name)
      return { id, ...(name !== undefined ? { name } : {}), ...capacityOf(value) }
    }
    return { id }
  })
}

/**
 * Response normalization matrix (opencode/cc-switch shapes accepted): array of
 * rows | {data|models|items:[...]} | {data|models|items:{id:row}} | bare
 * {id:row|name} record map. Returns undefined for an unsupported shape so the
 * probe can brand it.
 */
function normalizeModelList(body: unknown): ModelDescriptor[] | undefined {
  if (Array.isArray(body)) return normalizeRows(body)
  if (!isRecordLike(body)) return undefined
  for (const key of ["data", "models", "items"] as const) {
    if (!(key in body)) continue
    const container = body[key]
    if (Array.isArray(container)) return normalizeRows(container)
    if (isRecordLike(container)) return normalizeMap(container)
    return undefined // container present but scalar/null → unsupported shape
  }
  if (Object.values(body).every((v) => v === null || typeof v === "string" || isRecordLike(v))) {
    return normalizeMap(body)
  }
  return undefined
}

/** One candidate request's outcome. `tryNext` = the sibling candidate is worth
 * trying: HTTP status errors (4xx/5xx) may just be the wrong path; transport
 * and 2xx-shape failures are structural — the second candidate shares them. */
type CandidateResult =
  | { kind: "ok"; models: ModelDescriptor[] }
  | { kind: "error"; text: string; tryNext: boolean }

async function probeCandidate(url: string, headers: Record<string, string>): Promise<CandidateResult> {
  let response: Response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (error) {
    // A black-hole/unroutable baseURL rejects here — must never escape as an
    // unbranded failure; the abort signal contributes its TimeoutError/AbortError.
    const timedOut = error instanceof DOMException
      && (error.name === "TimeoutError" || error.name === "AbortError")
    return {
      kind: "error",
      text: `GET ${url} ${timedOut ? `timed out after ${PROBE_TIMEOUT_MS / 1000}s` : "failed (network error)"}`,
      tryNext: false,
    }
  }
  if (!response.ok) return { kind: "error", text: `GET ${url} → ${response.status}`, tryNext: true }
  // A 2xx with a non-JSON body (error-page HTML, proxy message) makes
  // response.json() throw a bare SyntaxError — brand it with the same code the
  // route maps to the probe family.
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: "error", text: `GET ${url} body is not JSON — expected {data:[{id}]}`, tryNext: false }
  }
  let models: ModelDescriptor[] | undefined
  try {
    models = normalizeModelList(body)
  } catch (error) {
    if (error instanceof ModelProbeFailedError) {
      return { kind: "error", text: `GET ${url} ${error.message.replace(/^model probe failed: /, "")}`, tryNext: false }
    }
    throw error
  }
  if (models === undefined) {
    return {
      kind: "error",
      text: `GET ${url} returned an unsupported shape (expected an array | {data|models|items} | a {id: …} record map)`,
      tryNext: false,
    }
  }
  return { kind: "ok", models }
}

/** Resolve + validate the probe base URL (an unsaved draft wins over the
 * registered profile). Only http(s) is a probeable endpoint, and a trailing
 * slash is normalized so `${base}/v1/models` never builds `//v1/models`. */
function probeBaseURL(req: ProbeRequest, profile: ProviderProfile | undefined): string | undefined {
  const base = req.baseURL ?? profile?.baseUrl
  if (base === undefined || base === "") return undefined
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    throw new ModelProbeFailedError(`model probe failed: invalid baseURL "${base}"`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelProbeFailedError(
      `model probe failed: invalid baseURL "${base}" (only http/https supported)`,
    )
  }
  return base.replace(/\/+$/, "")
}

/**
 * The built-in discovery probe (Task 2 — the openai-compatible route's own
 * probe, D5: custom providers share that route): protocol-aware auth headers
 * (Bearer for the OpenAI family, x-api-key + anthropic-version for
 * anthropic-messages), DUAL candidates ({base}/v1/models then {base}/models),
 * and richer response normalization. The protocol resolution chain (settings'
 * resolveProviderProtocol) runs at the CALLER — here only the generic terminal
 * fallback is applied. The caller may pass an UNSAVED draft — the registered
 * profile's baseUrl/apiKey are only the fallback when the request omits them.
 *
 * baseURL convention (converged): host ROOT, no `/v1` — the adapter itself
 * builds `${baseUrl}/v1/chat/completions`, so a `/v1`-inclusive entry would
 * double the path and break chat; one settings value must serve both.
 */
function createBuiltinProbe(resolveProfile: () => ProviderProfile | undefined): Probe {
  return async (req: ProbeRequest): Promise<ModelDescriptor[]> => {
    const profile = resolveProfile()
    const baseURL = probeBaseURL(req, profile)
    if (baseURL === undefined) {
      throw new ModelProbeFailedError(
        'model probe failed: baseURL is required (or configure the route "baseURL")',
      )
    }
    const protocol = req.protocol ?? "openai-completions"
    const apiKey = req.apiKey ?? profile?.apiKey
    const headers = probeAuthHeaders(protocol, apiKey)
    const failures: string[] = []
    for (const url of probeCandidatePaths(baseURL)) {
      const result = await probeCandidate(url, headers)
      if (result.kind === "ok") return result.models
      failures.push(result.text)
      if (!result.tryNext) break
    }
    const summary = failures.length === 1
      ? failures[0] as string
      : `${failures.length} candidate attempts failed: ${failures.join("; ")}`
    throw new ModelProbeFailedError(`model probe failed: ${summary}`)
  }
}

export function createProviderRegistry(): ProviderRegistry {
  const profiles = new Map<string, ProviderProfile>()
  const probes = new Map<string, Probe>()
  // Built-in route probe: the openai-compatible adapter declares no catalog, so
  // its route probes the live endpoint over HTTP (protocol-aware headers per
  // req.protocol, dual candidates — Task 2). deepseek/anthropic/openai declare
  // no catalogs either — those routes fall back to the profile's static
  // `models`. Kept OUT of the probes map so an explicit registerProbe for the
  // route can override it and probeModels can fall back to the static catalog
  // before giving up (no baseURL + static models = offline-usable custom route).
  const builtinProbe = createBuiltinProbe(() => profiles.get(OPENAI_COMPATIBLE_ROUTE))
  return {
    register(profile) {
      if (profiles.has(profile.name)) throw new Error(`duplicate provider: ${profile.name}`)
      validateModelContext(profile)
      validateRetryPolicy(profile.retryPolicy) // M20: fail loud at registration on invalid retry config
      profiles.set(profile.name, profile)
    },
    get(name) { return profiles.get(name) },
    list() { return [...profiles.values()] },
    remove(name) { profiles.delete(name) },
    describeDirectory() { return [...profiles.values()].map(toDirectoryEntry) },
    registerProbe(route, probe) { probes.set(route, probe) },
    async probeModels(route, req) {
      const explicit = probes.get(route)
      if (explicit !== undefined) return explicit(req)
      const profile = profiles.get(route)
      const baseURL = req.baseURL ?? profile?.baseUrl
      // Task 7 (D4 gap): a request carrying an EXPLICIT baseURL probes an
      // UNSAVED DRAFT — the route gate cannot apply (a custom route the
      // registry never seeded has no route probe and no static catalog). Run
      // the generic builtin probe for ANY route: dual candidates, protocol-aware
      // headers (req.protocol), both response shapes — with the route's OWN
      // registered profile (when it exists) as the omitted-field fallback,
      // never the openai-compatible route's profile.
      if (req.baseURL !== undefined && req.baseURL !== "") {
        return createBuiltinProbe(() => profile)(req)
      }
      // Route-based flow (previews — the request omitted the draft fields and
      // the route's own config drives): the built-in route probe whenever a
      // base URL exists (profile-level fallback — discovery IS the
      // openai-compatible route's content; the static catalog is only the
      // offline fallback for a route with no base URL at all).
      if (route === OPENAI_COMPATIBLE_ROUTE && baseURL !== undefined && baseURL !== "") {
        return builtinProbe(req)
      }
      if (profile !== undefined && profile.models !== undefined && profile.models.length > 0) {
        return profile.models.map((id) => ({ id }))
      }
      // The route's probe exists (it IS the openai-compatible route) but the
      // request carries no base URL — that is the probe failing, not being
      // unavailable, so the branded failure wins over ProbeUnavailableError.
      if (route === OPENAI_COMPATIBLE_ROUTE) return builtinProbe(req)
      throw new ProbeUnavailableError(route)
    },
  }
}

// ── Module-level conveniences (plan interface) ───────────────────────────────
// The standalone describeDirectory/registerProbe/probeModels operate on the
// module default registry — the registration API is unchanged (`register`).
// Embeddings that own a specific registry should pass it through its methods
// instead (createProviderRegistry instances are independent).
let defaultRegistry: ProviderRegistry | undefined

/** The module-level default registry the standalone functions use (one per module). */
export function defaultProviderRegistry(): ProviderRegistry {
  if (defaultRegistry === undefined) defaultRegistry = createProviderRegistry()
  return defaultRegistry
}

export function describeDirectory(): DirectoryEntry[] {
  return defaultProviderRegistry().describeDirectory()
}

export function registerProbe(route: string, probe: Probe): void {
  defaultProviderRegistry().registerProbe(route, probe)
}

export function probeModels(route: string, req: ProbeRequest): Promise<ModelDescriptor[]> {
  return defaultProviderRegistry().probeModels(route, req)
}

// M15: context windows fail loud at registration (no defaults injected —
// absence means "unknown, fall back to config").
function validateWindow(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`provider: ${label} must be a positive integer (got ${value})`)
  }
}

function validateModelContext(profile: ProviderProfile): void {
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
function validateRetryPolicy(policy: RetryPolicyConfig | undefined): void {
  resolveRetryPolicy(policy)
}

// Builds a ModelClient by dispatching on the provider's protocol. extra is
// passed through to the model end as request-body options (e.g.
// reasoning_effort). When model is omitted, profile.defaultModel is used,
// falling back to "gpt-4o". Unknown protocols error here, and bad models
// error at the model end.
function buildClient(profile: ProviderProfile, model: string, extra?: Record<string, unknown>): ModelClient {
  switch (profile.protocol) {
    case "openai-responses":
      return createOpenAIClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, options: extra, inputModalities: profile.inputModalities })
    case "openai-compatible":
      return createOpenAICompatibleClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, options: extra, inputModalities: profile.inputModalities })
    case "anthropic-messages":
      return createAnthropicClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, options: extra, inputModalities: profile.inputModalities })
    case "gemini":
      return createGeminiClient({ apiKey: profile.apiKey ?? "", baseUrl: profile.baseUrl, model, options: extra, inputModalities: profile.inputModalities })
    case "bedrock":
      // No apiKey — the AWS credential chain (env / ~/.aws/credentials /
      // IMDS) resolves at the SDK client; region defaults from the env in the
      // adapter (AWS_REGION → us-east-1).
      return createBedrockClient({ model, options: extra, inputModalities: profile.inputModalities })
    default:
      throw new Error(`unknown provider protocol: ${String((profile as { protocol?: unknown }).protocol)}`)
  }
}

// M20: when profile.retryPolicy is set, the protocol client is wrapped with
// the retrying client; the policy was validated at registration (or here at
// build time, defensively — resolveRetryPolicy also throws). Absent policy,
// the unwrapped protocol client is returned as before.
export function buildModelClient(profile: ProviderProfile, model?: string, extra?: Record<string, unknown>): ModelClient {
  const resolved = model ?? profile.defaultModel ?? "gpt-4o"
  const client = buildClient(profile, resolved, extra)
  if (profile.retryPolicy === undefined) return client
  return createRetryingClient(client, resolveRetryPolicy(profile.retryPolicy))
}

// ── Task 4: RESOLVED wire protocol → adapter dispatch ─────────────────────────
// The profile's `protocol` field is the registry's ADAPTER-KIND marker
// (describeDirectory / the headless parseModel order). The WEB build (and the
// T2 probe) dispatch on the RESOLVED THREE-value wire vocabulary that
// settings' resolveProviderProtocol produces (user section > SEEDED_PROTOCOLS >
// DEFAULT): the same keys ProbeRequest.protocol carries. A user who re-wires a
// seeded route (e.g. deepseek → anthropic-messages) must get the anthropic
// client even though the profile's marker still says "openai-compatible".

/** The adapter inputs, protocol-independent — the shared shape of all three
 * client factories (llm-openai-compatible / llm-openai / llm-anthropic). */
export interface WireClientConfig {
  apiKey: string
  baseUrl?: string
  model: string
  options?: Record<string, unknown>
  inputModalities?: ("text" | "image")[]
}

/** Build the adapter client for a RESOLVED wire protocol; undefined for an
 * unknown protocol so the caller owns the warn + mock fallback. */
export function buildWireClient(protocol: string, config: WireClientConfig): ModelClient | undefined {
  switch (protocol) {
    case "openai-completions":
      return createOpenAICompatibleClient(config)
    case "openai-responses":
      return createOpenAIClient(config)
    case "anthropic-messages":
      return createAnthropicClient(config)
    case "gemini":
      return createGeminiClient(config)
    case "bedrock":
      // Key-less by design (AWS credential chain); apiKey is ignored.
      return createBedrockClient({ model: config.model, options: config.options, inputModalities: config.inputModalities })
    default:
      return undefined
  }
}

// ── M26-B3 → M31: websearch provider seam（同 interaction/questions 模式）──
// M31 契約升級（spec §3.1, dsh-honest）：websearch 全鏈對「當下一個 provider 的
// 真實所見」負責——sources 行是 {url 必需, title/snippet/publishedAt 可選}，可用
// `truncated` 標記告知結果被裁剪（誠信：不逼 provider 編造 title/日期）；maxResults
// 由 seam 層強制（截斷在此執行）。註冊帶 id（多 provider 可駐留）；選擇 = 釘選 id
// > 唯一可用 > 失敗（dsh WebError 語義）。零默認：無內建 provider 註冊。
import type { PluginContext } from "@i-harness/core-plugin"

export interface WebSearchRequest {
  query: string
  maxResults?: number
}

/** One search result row: `url` is the only required field — a provider must
 * never be forced to invent a title or date it does not know. */
export interface WebSearchSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

/** The provider's honest view of one search: the truncation boundary is the
 * seam's job (`truncated` marks it); `content` is an optional named summary. */
export interface WebSearchResult {
  content?: string
  sources: WebSearchSource[]
  truncated: boolean
}

/** Contract of a registered websearch provider. `signal` comes from the
 * calling tool's execution context (abort on tool timeout/disconnect). */
export interface WebSearchProvider {
  search(req: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}

/** Id-keyed registration (dsh searchProviderId pin surface): one ctx slot holds
 * the map; duplicate service-name registration is the services registry's own
 * failure class + a duplicate ID fails loud (two plugins claiming one id is a
 * composition bug). */
export function registerWebSearchProvider(ctx: PluginContext, id: string, provider: WebSearchProvider): void {
  if (id === "") throw new Error("websearch provider id must be a non-empty string")
  let providers: Map<string, WebSearchProvider>
  try {
    providers = ctx.services.get<Map<string, WebSearchProvider>>("websearch/provider")
  } catch {
    providers = new Map()
    ctx.services.register("websearch/provider", providers)
  }
  if (providers.has(id)) throw new Error(`duplicate websearch provider id: ${id}`)
  providers.set(id, provider)
}

/** Selection per spec §3.1: pinned id > exactly-one usable > error. Returns
 * undefined when NO provider is registered at all — the websearch tool is then
 * simply not registered (the zero-default fail-closed stance); a pin that does
 * not resolve or multiple candidates without a pin THROW (misconfiguration —
 * fail loud at assembly, never a silent drop). */
export function tryGetWebSearchProvider(ctx: PluginContext, pinnedId?: string): WebSearchProvider | undefined {
  let providers: Map<string, WebSearchProvider>
  try {
    providers = ctx.services.get<Map<string, WebSearchProvider>>("websearch/provider")
  } catch {
    return undefined
  }
  if (pinnedId !== undefined) {
    const provider = providers.get(pinnedId)
    if (provider === undefined) {
      throw new Error(`websearch provider ${pinnedId} is not registered (NO_PROVIDER)`)
    }
    return provider
  }
  if (providers.size === 0) return undefined
  if (providers.size === 1) return [...providers.values()][0]!
  const ids = [...providers.keys()].sort().join(", ")
  throw new Error(`multiple websearch providers registered (${ids}); pin one via searchProviderId (MULTIPLE_PROVIDERS)`)
}

// fail-closed：無 provider → 同步 throw（NO_PROVIDER），呼叫端（web 工具）不需 await 就看到。
export function getWebSearchProvider(ctx: PluginContext, pinnedId?: string): WebSearchProvider {
  const provider = tryGetWebSearchProvider(ctx, pinnedId)
  if (provider === undefined) throw new Error("no websearch provider is registered (NO_PROVIDER)")
  return provider
}
