import { validatePromptCacheConfig } from "@i-harness/llm-seam"
import type { DirectoryEntry, ProviderProfile, ProviderRegistry, Probe } from "../types.ts"
import { validateModelContext, validateRetryPolicy } from "../clients/validation.ts"
import { createBuiltinProbe } from "./http.ts"
import { ProbeUnavailableError } from "./errors.ts"

const OPENAI_COMPATIBLE_ROUTE = "openai-compatible"

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
      validatePromptCacheConfig(profile.promptCache)
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
      // Task 7 (D4 gap): a request carrying an EXPLICIT URL probes an UNSAVED
      // DRAFT — the route gate cannot apply (a custom route the registry never
      // seeded has no route probe and no static catalog). Run the generic
      // builtin probe for ANY route: exact modelsURL or baseURL candidates,
      // protocol-aware headers (req.protocol), both response shapes — with the
      // route's OWN registered profile (when it exists) as the omitted-field
      // fallback, never the openai-compatible route's profile.
      if ((req.modelsURL !== undefined && req.modelsURL !== "")
        || (req.baseURL !== undefined && req.baseURL !== "")) {
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

// ── The module default registry ──────────────────────────────────────────────
// A plan once specified standalone `describeDirectory` / `registerProbe` /
// `probeModels` wrappers over this registry. They are gone (see the note below);
// what remains is the accessor, and embeddings that own a specific registry
// should pass it through its methods instead (`createProviderRegistry` instances
// are independent).
let defaultRegistry: ProviderRegistry | undefined

/** The module-level default registry (one per module). */
export function defaultProviderRegistry(): ProviderRegistry {
  if (defaultRegistry === undefined) defaultRegistry = createProviderRegistry()
  return defaultRegistry
}
