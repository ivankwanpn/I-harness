// @i-harness/tui — M46a G1: the model-clients factory resolution chain.
//
// The M37a defaultEmbeddedFactory seam (EmbeddedFactoryOptions.modelBuilder)
// lands here: the chain reads the settings `tui.providers` section + the
// `llm.defaultModel` selection + credential refs, assembles a provider
// profile and builds the ModelClient through packages/provider's
// buildModelClient (the M31 chain — the SAME dispatch apps/cli/src/web.ts's
// buildModelClient. This legacy factory now returns undefined on an unresolved
// model; production assembly policy decides whether that is an error.
//
//   --model flag ("provider:model") > settings llm.defaultModel > none
//
// The seed of the M31 chain never fabricates: an unknown provider, an
// unconfigured key or an unknown model WARN + resolve undefined, never
// a "gpt-4o" surprise (buildModelClient's history-default is not reached — the
// model id is always resolved by the caller).

import { buildModelClient } from "@i-harness/provider"
import type { ProviderProfile } from "@i-harness/provider"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderEntry, ProviderStore } from "./provider-store.ts"

/** The M31-chain protocol mapping (TUI vocabulary → the provider package's).
 * Absent protocol = the universal default (openai-compatible) — the same
 * default RESOLVED protocol chain's terminal fallback claims. */
export function mapTuiProtocol(
  protocol: ProviderEntry["protocol"],
): ProviderProfile["protocol"] {
  switch (protocol) {
    case "anthropic": return "anthropic-messages"
    case "openai-compatible": return "openai-compatible"
    case "openai-responses": return "openai-responses"
    case "gemini": return "gemini"
    case "bedrock": return "bedrock"
    default: return "openai-compatible"
  }
}

/** ProviderProfile assembly from a TUI entry + resolved key (the M31 chain's
 * profile-merge step; inputModalities/contextWindow stay absent = provider
 * defaults, exactly like the web path's unconfigured route). */
export function providerProfileFromEntry(entry: ProviderEntry, apiKey: string): ProviderProfile {
  return {
    name: entry.id,
    displayName: entry.name ?? entry.id,
    protocol: mapTuiProtocol(entry.protocol),
    baseUrl: entry.baseUrl,
    apiKey,
  }
}

export interface TuiModelResolution {
  /** Resolved provider id ("" = none). */
  provider: string
  /** Resolved model id (may be "" when the provider is known but no model was
   * ever selected — the builder then resolves no client). */
  model: string
  source: "flag" | "settings" | "none"
}

/**
 * The pure chain: `--model provider:model` > settings llm.defaultModel
 * ({provider, model}) > none. `flagModel` is the host's --model spec ("" /
 * undefined = absent). A malformed flag ("provider" without ":model" or an
 * unknown flag provider) degrades to settings (the settings arm stays the
 * durable truth); a flag that parses wins and the store existence check
 * happens in the builder.
 */
export function resolveTuiModel(store: ProviderStore, flagModel?: string): TuiModelResolution {
  if (flagModel !== undefined && flagModel !== "") {
    const sep = flagModel.indexOf(":")
    if (sep > 0) {
      const provider = flagModel.slice(0, sep)
      const model = flagModel.slice(sep + 1)
      return { provider, model, source: "flag" }
    }
  }
  const dm = store.defaultModel()
  if (dm.provider !== "" && dm.model !== "") {
    return { provider: dm.provider, model: dm.model, source: "settings" }
  }
  return { provider: "", model: "", source: "none" }
}

/**
 * The modelBuilder seam (SessionServiceOptions.modelBuilder shape — the same
 * call sites apps/cli's buildModelFor serves): read the TUI store → resolve
 * the chain → assemble the profile → buildModelClient. Every failure arm
 * WARNs + returns undefined; production callers fail through required model
 * policy, while tests may opt into test-mock explicitly.
 */
export function createTuiModelBuilder(opts: {
  store: ProviderStore
  /** The host's --model flag (flag > settings). */
  flagModel?: string
}): () => Promise<ModelClient | undefined> {
  const { store, flagModel } = opts
  return async (): Promise<ModelClient | undefined> => {
    const res = resolveTuiModel(store, flagModel)
    if (res.provider === "") return undefined
    const entry = store.get(res.provider)
    if (entry === undefined) {
      console.warn(`[i-harness] model "${res.provider}" (${res.source}) unavailable — provider not configured`)
      return undefined
    }
    if (res.model === "") {
      console.warn(`[i-harness] model "${res.provider}" (${res.source}) unavailable — no model selected`)
      return undefined
    }
    const apiKey = store.resolveKey(res.provider)
    if (apiKey === undefined || apiKey === "") {
      console.warn(`[i-harness] model "${res.provider}:${res.model}" (${res.source}) unavailable — no API key for "${res.provider}"`)
      return undefined
    }
    try {
      return buildModelClient(providerProfileFromEntry(entry, apiKey), res.model)
    } catch (error) {
      console.warn(
        `[i-harness] model "${res.provider}:${res.model}" (${res.source}) unavailable: `
        + (error instanceof Error ? error.message : String(error)),
      )
      return undefined
    }
  }
}
