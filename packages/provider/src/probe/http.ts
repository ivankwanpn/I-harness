import { describeTransportError } from "@i-harness/llm-seam"
import type { ModelDescriptor, Probe, ProbeRequest, ProviderProfile } from "../types.ts"
import { ModelProbeFailedError } from "./errors.ts"
import { normalizeModelList } from "./normalization.ts"

/** Hard ceiling on one probe request — a black-hole/unroutable baseURL must
 * never hang the settings UI request (Task 4's POST /api/llm/probe). */
const PROBE_TIMEOUT_MS = 10_000

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

/** One candidate request's outcome. `tryNext` = the sibling candidate is worth
 * trying: HTTP status errors (4xx/5xx) may just be the wrong path; transport
 * and 2xx-shape failures are structural — the second candidate shares them. */
type CandidateResult =
  | { kind: "ok"; models: ModelDescriptor[] }
  | { kind: "error"; text: string; tryNext: boolean }

async function probeCandidate(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<CandidateResult> {
  let response: Response
  try {
    signal?.throwIfAborted()
    response = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(PROBE_TIMEOUT_MS) })
  } catch (error) {
    signal?.throwIfAborted()
    // A black-hole/unroutable baseURL rejects here — must never escape as an
    // unbranded failure; the abort signal contributes its TimeoutError/AbortError.
    const timedOut = error instanceof DOMException
      && (error.name === "TimeoutError" || error.name === "AbortError")
    if (timedOut) {
      return {
        kind: "error",
        text: `GET ${url} timed out after ${PROBE_TIMEOUT_MS / 1000}s`,
        tryNext: false,
      }
    }
    // M62: "failed (network error)" discarded the layer, so a DNS failure, a
    // TLS-inspecting gateway and a misconfigured proxy all read identically —
    // the operator cannot tell which knob to turn. describeTransportError walks
    // Node's `cause` chain (this fetch is already wrapped in try/catch here, so
    // the failure was surfaced but not explained) and names the layer.
    const described = await describeTransportError("model probe", url, error)
    return { kind: "error", text: described.message, tryNext: false }
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

function validateProbeURL(value: string, label: "baseURL" | "modelsURL"): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ModelProbeFailedError(`model probe failed: invalid ${label} "${value}"`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelProbeFailedError(
      `model probe failed: invalid ${label} "${value}" (only http/https supported)`,
    )
  }
  return value
}

/** Resolve + validate the probe base URL (an unsaved draft wins over the
 * registered profile). A trailing slash is normalized so
 * `${base}/v1/models` never builds `//v1/models`. */
function probeBaseURL(req: ProbeRequest, profile: ProviderProfile | undefined): string | undefined {
  const base = req.baseURL ?? profile?.baseUrl
  if (base === undefined || base === "") return undefined
  return validateProbeURL(base, "baseURL").replace(/\/+$/, "")
}

/** M60 E: configured headers + the adapter's auth headers, adapter-owned
 * names winning. The drop is CASE-INSENSITIVE: Fetch combines `Authorization`
 * and `authorization` into one comma-joined value, so an exact-key spread
 * would leave a case-variant duplicate alive. */
function mergeProbeHeaders(
  configured: Record<string, string> | undefined,
  auth: Record<string, string>,
): Record<string, string> {
  if (configured === undefined) return auth
  const owned = new Set(Object.keys(auth).map((key) => key.toLowerCase()))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(configured)) {
    if (!owned.has(key.toLowerCase())) out[key] = value
  }
  return { ...out, ...auth }
}

/** Validate an explicit full models endpoint without rewriting it. */
function probeModelsURL(req: ProbeRequest): string | undefined {
  const modelsURL = req.modelsURL
  if (modelsURL === undefined || modelsURL === "") return undefined
  return validateProbeURL(modelsURL, "modelsURL")
}

/**
 * The built-in discovery probe (Task 2 — the openai-compatible route's own
 * probe, D5: custom providers share that route): protocol-aware auth headers
 * (Bearer for the OpenAI family, x-api-key + anthropic-version for
 * anthropic-messages), an exact explicit modelsURL OR the baseURL DUAL
 * candidates ({base}/v1/models then {base}/models), and richer response
 * normalization. The protocol resolution chain (settings'
 * resolveProviderProtocol) runs at the CALLER — here only the generic terminal
 * fallback is applied. The caller may pass an UNSAVED draft — the registered
 * profile's baseUrl/apiKey are only the fallback when the request omits them.
 *
 * baseURL convention (converged): host ROOT, no `/v1` — the adapter itself
 * builds `${baseUrl}/v1/chat/completions`, so a `/v1`-inclusive entry would
 * double the path and break chat; one settings value must serve both.
 */
export function createBuiltinProbe(resolveProfile: () => ProviderProfile | undefined): Probe {
  return async (req: ProbeRequest): Promise<ModelDescriptor[]> => {
    const profile = resolveProfile()
    const modelsURL = probeModelsURL(req)
    const baseURL = modelsURL === undefined ? probeBaseURL(req, profile) : undefined
    if (modelsURL === undefined && baseURL === undefined) {
      throw new ModelProbeFailedError(
        'model probe failed: modelsURL or baseURL is required (or configure the route "baseURL")',
      )
    }
    const protocol = req.protocol ?? "openai-completions"
    const apiKey = req.apiKey ?? profile?.apiKey
    // M60 E: the route's configured headers ride along; the adapter's own auth
    // keys (Authorization / x-api-key / x-goog-api-key / anthropic-version)
    // win on collision — the caller never overrides the wire's auth shape.
    const headers = mergeProbeHeaders(req.headers, probeAuthHeaders(protocol, apiKey))
    const failures: string[] = []
    const candidates = modelsURL !== undefined ? [modelsURL] : probeCandidatePaths(baseURL!)
    for (const url of candidates) {
      req.signal?.throwIfAborted()
      const result = await probeCandidate(url, headers, req.signal)
      req.signal?.throwIfAborted()
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
