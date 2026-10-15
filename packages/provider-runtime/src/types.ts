import type { VideoAudioInput, VideoAudioResult } from "./video-audio.ts"
import type { CredentialStore, ProviderAuthResolver } from "@i-harness/credentials"
import type { ModelClient, ReasoningEffort } from "@i-harness/llm-seam"
import type { buildModelClient, ModelDescriptor, ProviderProtocol, ProviderRegistry } from "@i-harness/provider"
import type { SettingsDefaultModel, SettingsInputModality, SettingsModel, SettingsProviderConfig, SettingsProviderProtocol, SettingsStoreSurface } from "@i-harness/settings"

export type ModelResolutionState =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; binding: SessionModelBinding }

/** The per-model fields a caller may set. `null` CLEARS the field (falling back
 * to the card), which is NOT the same as omitting it (leave it alone).
 *
 * Deliberately NOT exported from the package facade: every caller (the CLI
 * included) passes an OBJECT LITERAL to `setModel`, so nothing outside this
 * package needs to name the type, and the reachability gate counts public
 * type exports as rows — exporting it would
 * book an orphan until its first consumer landed. */
export interface ModelFields {
  protocol?: SettingsProviderProtocol | null
  contextWindow?: number | null
  maxTokens?: number | null
  name?: string | null
  inputModalities?: SettingsInputModality[] | null
}

/** The route fields `patchProvider` may change. `models` is absent ON PURPOSE —
 * see the method. `null` CLEARS the field. Internal only: see `ModelFields`. */
export interface ProviderPatch {
  baseURL?: string | null
  protocol?: SettingsProviderProtocol | null
  catalog?: string | null
  displayName?: string | null
  modelsURL?: string | null
  apiKeyEnv?: string | null
  promptCache?: SettingsProviderConfig["promptCache"] | null
}

export interface SessionModelBinding {
  budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding
  contextMetadata?: import("@i-harness/core-session").ContextBindingMetadata
  client: ModelClient
  providerId: string
  modelId: string
  label: string
  protocol?: ProviderProtocol
  reasoningEffort?: ReasoningEffort
  /** UI choices for this binding's effective protocol; model-specific rejection remains with the provider. */
  reasoningEfforts?: ReasoningEffort[]
  contextWindow?: number
  /** M72 Ⅱ: the resolved output cap (user row > card). Absent → the adapter
   * sends nothing (anthropic falls back to its own constant). */
  maxOutputTokens?: number
  /** Only an explicit route/model image declaration enables image input. */
  imageInput?: true
}

export interface ProviderRuntimeEntry {
  oauthAccountId?: string
  oauthProvider?: "openai-codex"
  videoAudioModel?: string
  id: string
  displayName: string
  baseURL?: string
  modelsURL?: string
  apiKeyEnv?: string
  /** The route's DECLARED wire protocol. ABSENT means the route declares none
   * OF ITS OWN — which is not a default, and NOT a verdict on usability: the
   * resolution chain is selection > model row > route (`resolveModel`), so
   * such a route still resolves whenever a row or a selection names one. It
   * refuses only when all three are silent. A listing must therefore not
   * render the absence as a wire, and must not claim the route cannot be used. */
  protocol?: SettingsProviderProtocol
  configured: boolean
  auth: {
    configured: boolean
    source?: "env" | "file" | "ambient" | "oauth"
    writable: boolean
  }
  models: ModelDescriptor[]
  defaultModel?: string
  /** Persisted user choice for this route, distinct from a catalog fallback. */
  selectedDefaultModel?: string
  discovery: "available" | "manual-only"
  /** The card family this route declared, if it declared one. ABSENT means the
   * route name IS the family (the default — see ProviderProfile.catalog), which
   * is not the same statement as "the family is the route name", so a reader
   * that needs to tell them apart reads this field's PRESENCE. */
  catalog?: string
  /** The family the resolution chain actually keys `model-catalog.json` by:
   * the declared one, else the route name. Reported instead of leaving every
   * consumer to re-derive the rule — a listing that computes it a second time
   * is a listing that can disagree with the chain it is describing. */
  cardFamily: string
  promptCache?: SettingsProviderConfig["promptCache"]
}

export interface ProviderRuntime {
  describeModelBindingMetadata?(input: Parameters<ProviderRuntime["resolveModel"]>[0]): import("@i-harness/core-session").ContextBindingMetadata | undefined | Promise<import("@i-harness/core-session").ContextBindingMetadata | undefined>
  setVideoAudioModel?(selection: { provider: string; model: string } | null): Promise<void>
  analyzeVideoAudio?(input: VideoAudioInput): Promise<VideoAudioResult>
  directory(): Promise<ProviderRuntimeEntry[]>
  upsertProvider(id: string, config: SettingsProviderConfig): Promise<void>
  /** Create a route. Refuses an id that already exists — `patchProvider` is the
   * verb for changing one, so a typo cannot silently rewrite a live route. */
  createProvider(id: string, fields: Omit<SettingsProviderConfig, "models" | "inputModalities">): Promise<void>
  /** Change named fields on an existing route. `models` is deliberately NOT
   * patchable: changing a protocol or a base URL must not empty the catalog the
   * route holds. `null` clears a field. */
  patchProvider(id: string, patch: ProviderPatch): Promise<void>
  removeProvider(id: string): Promise<void>
  setApiKey(id: string, value: string): Promise<void>
  clearApiKey(id: string): Promise<void>
  /** What the route's endpoint offers, WITHOUT writing anything. The read half
   * of `discoverModels` — see that method for why the two are separate.
   *
   * `protocol` rides the REQUEST only (design §4): it changes the shape of this
   * probe's auth headers — one gateway can serve a vendor's models on a
   * protocol other than the route's — and it is never stored. Omitted means the
   * route's own protocol, which is why `discoverModels` above never passes it. */
  probeModels(id: string, options?: { signal?: AbortSignal; protocol?: SettingsProviderProtocol }): Promise<ModelDescriptor[]>
  /** Add rows, or complete existing ones. EXISTING ROWS WIN — this is the
   * `mergeDiscoveredModels` rule, and it is what keeps a probe from clobbering
   * numbers the user set. To change an existing row, use `setModel`. */
  addModels(id: string, rows: readonly SettingsModel[]): Promise<ModelDescriptor[]>
  /** Account catalogs are authoritative snapshots, including an empty result. */
  replaceSubscriptionModels(id: string, accountId: string, rows: readonly SettingsModel[]): Promise<void>
  /** Change named fields on ONE existing row. `null` clears a field (the CLI's
   * `auto`); an omitted field is left alone. */
  setModel(id: string, modelId: string, fields: ModelFields): Promise<ModelDescriptor[]>
  /** Remove one row. The route and its credential are untouched. */
  removeModel(id: string, modelId: string): Promise<ModelDescriptor[]>
  discoverModels(
    id: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<ModelDescriptor[]>
  setDefaultModel(selection: SettingsDefaultModel): Promise<void>
  resolveModel(input: {
    /** The explicit selection. Named for the session because that is who
     * usually makes it, but a SUB-AGENT ROLE supplies one too — the child is a
     * session, and both go through this one chain. */
    sessionSelection?: { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string }
    override?: string
  }): Promise<ModelResolutionState>
}

export interface CreateProviderRuntimeOptions {
  settings: SettingsStoreSurface
  credentials: CredentialStore
  auth?: ProviderAuthResolver
  registry?: ProviderRegistry
  buildClient?: typeof buildModelClient
  /** File hosts provide a fresh snapshot without mutating the operation store. */
  readModelWait?: () => Promise<import("@i-harness/settings").ModelWaitSettings>
  readModelRetryLimit?: () => Promise<number>
  codex?: {
    state(): Promise<{ accountId?: string; status: string }>
    token(accountId: string, signal?: AbortSignal): Promise<{ accessToken: string; accountId: string }>
    models(accountId: string): Promise<ModelDescriptor[]>
  }
}
