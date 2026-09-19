import {
  createProviderAuthResolver,
  type CredentialStore,
  type ProviderAuthRef,
  type ProviderAuthResolver,
  type ResolvedProviderAuth,
} from "@i-harness/credentials"
import type { ModelClient, ReasoningEffort } from "@i-harness/llm-seam"
import {
  buildModelClient,
  defaultProviderRegistry,
  resolveEffectiveModelContext,
  type ModelDescriptor,
  type ProviderProfile,
  type ProviderRegistry,
} from "@i-harness/provider"
import {
  PROVIDER_PROTOCOLS,
  resolveProviderProtocol,
  type SettingsDefaultModel,
  type SettingsInputModality,
  type SettingsLlm,
  type SettingsModel,
  type SettingsProviderConfig,
  type SettingsProviderProtocol,
  type SettingsStoreSurface,
} from "@i-harness/settings"

export type ModelResolutionState =
  | { status: "unconfigured"; reason: string }
  | { status: "invalid"; reason: string; providerId?: string; modelId?: string }
  | { status: "ready"; binding: SessionModelBinding }

/** The per-model fields a caller may set. `null` CLEARS the field (falling back
 * to the card), which is NOT the same as omitting it (leave it alone).
 *
 * Deliberately NOT exported: every caller (the CLI included) passes an OBJECT
 * LITERAL to `setModel`, so nothing outside this module needs to name the type,
 * and the reachability gate counts type exports as rows — exporting it would
 * book an orphan until its first consumer landed. */
interface ModelFields {
  protocol?: SettingsProviderProtocol | null
  contextWindow?: number | null
  maxTokens?: number | null
  name?: string | null
}

/** The route fields `patchProvider` may change. `models` is absent ON PURPOSE —
 * see the method. `null` CLEARS the field. Not exported: see `ModelFields`. */
interface ProviderPatch {
  baseURL?: string | null
  protocol?: SettingsProviderProtocol | null
  catalog?: string | null
  displayName?: string | null
  modelsURL?: string | null
  apiKeyEnv?: string | null
}

/** The route fields `patchProvider` may change — a RUNTIME allowlist, not only
 * a type. `models` is absent ON PURPOSE (see the method), and a type cannot
 * enforce that here: the patch arrives as a variable, so TypeScript's
 * excess-property check never runs. */
const PATCHABLE_PROVIDER_FIELDS = ["baseURL", "protocol", "catalog", "displayName", "modelsURL", "apiKeyEnv"] as const

export interface SessionModelBinding {
  client: ModelClient
  providerId: string
  modelId: string
  label: string
  reasoningEffort?: ReasoningEffort
  contextWindow?: number
}

export interface ProviderRuntimeEntry {
  id: string
  displayName: string
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
}

export interface ProviderRuntime {
  directory(): Promise<ProviderRuntimeEntry[]>
  upsertProvider(id: string, config: SettingsProviderConfig): Promise<void>
  /** Create a route. Refuses an id that already exists — `patchProvider` is the
   * verb for changing one, so a typo cannot silently rewrite a live route. */
  createProvider(id: string, fields: Omit<SettingsProviderConfig, "models">): Promise<void>
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
}

interface ProviderView {
  id: string
  template?: ProviderProfile
  user?: SettingsProviderConfig
  displayName: string
  /** Absent = nobody declared one; see resolveProviderProtocol. */
  protocol?: SettingsProviderProtocol
  baseURL?: string
  modelsURL?: string
  apiKeyEnv?: string
  /** The model-card family this route draws capability metadata from. Absent →
   * the route name (see ProviderProfile.catalog). */
  catalog?: string
  /** M59: literal extra request headers (user config wins over the template). */
  headers?: Record<string, string>
  /** M61: the ROUTE's declared content types (user config wins over the
   * template; a model entry may narrow/override it — see resolveModel). */
  inputModalities?: SettingsInputModality[]
  models: ModelDescriptor[]
  defaultModel?: string
}

interface SelectedModel {
  providerId: string
  modelId: string
  /** Rides through from the session selection to `resolveModel`'s chain — a
   * selection's protocol is MORE specific than the model row's or the route's. */
  protocol?: SettingsProviderProtocol
  reasoningEffort?: string
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

/** The refusal names the SET, not a placeholder: `--protocol P` copied
 * verbatim fails with `unknown protocol "P"` — a second error before the fix.
 * Same correction as 5d0f2d89 ("P was the --provider placeholder"). */
const PROTOCOL_CHOICES = `<one of: ${PROVIDER_PROTOCOLS.join(" | ")}>`

export function createProviderRuntime(options: CreateProviderRuntimeOptions): ProviderRuntime {
  const registry = options.registry ?? defaultProviderRegistry()
  const auth = options.auth ?? createProviderAuthResolver(options.credentials)
  const buildClient = options.buildClient ?? buildModelClient
  const discovered = new Map<string, ModelDescriptor[]>()

  function providers(): Map<string, ProviderView> {
    const userProviders = options.settings.get().llm.providers
    const views = new Map<string, ProviderView>()
    for (const template of registry.list()) {
      const user = userProviders[template.name]
      views.set(template.name, providerView(template.name, template, user))
    }
    for (const [id, user] of Object.entries(userProviders)) {
      if (!views.has(id)) views.set(id, providerView(id, undefined, user))
    }
    return views
  }

  function provider(id: string): ProviderView | undefined {
    const user = options.settings.get().llm.providers[id]
    const template = registry.get(id)
    if (user === undefined && template === undefined) return undefined
    return providerView(id, template, user)
  }

  async function persistLlm(next: SettingsLlm): Promise<void> {
    await options.settings.set({ llm: next })
  }

  /** One probe, one credential resolution, no writes. The single implementation
   * behind `probeModels` and `discoverModels`. */
  async function probeRouteModels(
    id: string,
    probeOptions: { signal?: AbortSignal; protocol?: SettingsProviderProtocol },
  ): Promise<ModelDescriptor[]> {
    probeOptions.signal?.throwIfAborted()

    const view = provider(id)
    if (view === undefined) throw new Error(`provider "${id}" is not configured`)
    // The ROUTE's protocol, deliberately not the override's: bedrock has no
    // discovery endpoint, and that is a fact about the route — a request
    // parameter cannot conjure one.
    if (view.protocol === "bedrock") {
      throw new Error("Discovery is not available for this provider; add a model ID manually.")
    }

    const ref = authRef(view)
    if (ref === undefined) throw new Error(`No API key configured for provider "${id}"`)
    const resolvedAuth = await auth.resolve(ref, {
      providerId: id,
      purpose: "discovery",
      ...(probeOptions.signal !== undefined ? { signal: probeOptions.signal } : {}),
    })
    const apiKey = authValue(resolvedAuth)
    if (apiKey === undefined) throw new Error(`No API key configured for provider "${id}"`)
    probeOptions.signal?.throwIfAborted()

    // The SECOND tail (provider/src/index.ts:348-350 had its own
    // openai-completions/Bearer fallback). A probe must speak a wire it knows:
    // letting discovery succeed on a route that refuses unless a row or a
    // selection names a wire writes rows a later send can still refuse on,
    // which is worse than either alternative. `--protocol P` is the escape for
    // a gateway serving another vendor's models, and it is unchanged.
    const probeProtocol = probeOptions.protocol ?? view.protocol
    if (probeProtocol === undefined) {
      throw new Error(
        `provider "${id}" declares no protocol, so its models cannot be discovered; set one with: i-harness provider set ${id} --protocol ${PROTOCOL_CHOICES}`,
      )
    }

    const models = await registry.probeModels(id, {
      ...(view.modelsURL !== undefined
        ? { modelsURL: view.modelsURL }
        : view.baseURL !== undefined ? { baseURL: view.baseURL } : {}),
      apiKey,
      // The one-request override wins when given; the route's own declaration
      // is the fallback (and there is no fallback after it — see the refusal
      // above). This is the ONLY place the override is read — nothing below it
      // persists, so nothing below it needs to un-do anything.
      protocol: probeProtocol,
      // M60 E: the route's configured headers (a gateway may require one for
      // discovery too) — the probe's own auth keys still win.
      ...(view.headers !== undefined ? { headers: view.headers } : {}),
    })
    // Copied: the registry's array is not a caller's to mutate.
    return cloneModels(models)
  }

  /** Merge `rows` into the route's SETTINGS model list and persist once. The
   * existing row wins every field it has — see `mergeDiscoveredModels`. */
  async function addModelRows(id: string, rows: readonly SettingsModel[]): Promise<ModelDescriptor[]> {
    const additions: SettingsModel[] = rows.map((row) => {
      const modelId = row.id.trim()
      if (modelId === "") throw new Error("a model row needs a non-empty id")
      return { ...row, id: modelId }
    })
    if (additions.length === 0) throw new Error("addModels needs at least one row")

    const llm = canonicalLlm(options.settings)
    const current = llm.providers[id]
    const models = mergeDiscoveredModels(current?.models ?? [], additions)
    await persistLlm({
      providers: { ...llm.providers, [id]: { ...(current ?? {}), models } },
      defaultModel: { ...llm.defaultModel },
    })
    discovered.delete(id)
    return cloneModels(provider(id)?.models ?? models)
  }

  return {
    async directory() {
      const rows: ProviderRuntimeEntry[] = []
      for (const view of providers().values()) {
        const ref = authRef(view)
        const authInfo = ref === undefined
          ? { configured: false, writable: true }
          : await auth.describe(ref)
        rows.push({
          id: view.id,
          displayName: view.displayName,
          protocol: view.protocol,
          configured: view.user !== undefined,
          auth: { ...authInfo },
          models: cloneModels(view.models),
          ...(view.defaultModel !== undefined ? { defaultModel: view.defaultModel } : {}),
          discovery: view.protocol === "bedrock" ? "manual-only" : "available",
          cardFamily: cardFamilyOf(view),
          ...(view.catalog !== undefined ? { catalog: view.catalog } : {}),
        })
      }
      return rows
    },

    async upsertProvider(id, config) {
      assertProviderId(id)
      const llm = canonicalLlm(options.settings)
      await persistLlm({
        providers: { ...llm.providers, [id]: cloneProviderConfig(config) },
        defaultModel: { ...llm.defaultModel },
      })
      discovered.delete(id)
    },

    async createProvider(id, fields) {
      assertProviderId(id)
      const llm = canonicalLlm(options.settings)
      if (llm.providers[id] !== undefined) {
        // No sibling METHOD name in the message: a library caller can act on
        // "patchProvider", but this string also reaches a CLI user, for whom
        // that is not a command they can type. The surface adds its own hint.
        throw new Error(`provider "${id}" already exists`)
      }
      await persistLlm({
        providers: { ...llm.providers, [id]: cloneProviderConfig({ ...fields }) },
        defaultModel: { ...llm.defaultModel },
      })
      discovered.delete(id)
    },

    async patchProvider(id, patch) {
      assertProviderId(id)
      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      if (current === undefined) {
        throw new Error(`provider "${id}" is not configured`)
      }
      const next: SettingsProviderConfig = { ...current }
      // The KEYS come from the allowlist, never from the patch: `Object.entries`
      // here would let a variable-shaped patch (which the type cannot check —
      // no excess-property check applies) write `models` and empty the catalog
      // this method exists to protect.
      for (const key of PATCHABLE_PROVIDER_FIELDS) {
        if (!(key in patch)) continue
        const value = patch[key]
        if (value === undefined) continue
        if (value === null) delete next[key]
        else (next as unknown as Record<string, unknown>)[key] = value
      }
      // No baseURL suffix-stripping here: `SettingsStore.set` normalizes every
      // write (normalizeSettings → normalizeProviderConfig → stripBaseURLSuffix),
      // so a second implementation in the runtime would be a second place for
      // the rule to live — and the helper is module-private in settings, so
      // reaching it would mean exporting it for one caller.
      await persistLlm({
        providers: { ...llm.providers, [id]: cloneProviderConfig(next) },
        defaultModel: { ...llm.defaultModel },
      })
      discovered.delete(id)
    },

    async removeProvider(id) {
      assertProviderId(id)
      const llm = canonicalLlm(options.settings)
      if (llm.providers[id] === undefined) {
        // Legacy-only row: the canonical plane has no entry, but the read
        // migration re-projects the tui.providers pin on every load — drop
        // the pin row (the only way the removal sticks across a reload).
        await options.settings.dropLegacyTuiProvider?.(id)
        if (llm.defaultModel.provider === id) {
          await persistLlm({ providers: { ...llm.providers }, defaultModel: { provider: "", model: "" } })
        }
        discovered.delete(id)
        return
      }
      const nextProviders = { ...llm.providers }
      delete nextProviders[id]
      const defaultModel = llm.defaultModel.provider === id
        ? { provider: "", model: "" }
        : { ...llm.defaultModel }
      await persistLlm({ providers: nextProviders, defaultModel })
      // The legacy pin may carry the same id (per-id merge: canonical fields
      // win) — drop it too, or the reload projection resurrects the row.
      await options.settings.dropLegacyTuiProvider?.(id)
      discovered.delete(id)
    },

    async setApiKey(id, value) {
      assertProviderId(id)
      const ref = providerApiKeyRef(id)
      await options.credentials.set(ref, value)
      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      await persistLlm({
        providers: {
          ...llm.providers,
          [id]: { ...(current ?? {}), apiKeyEnv: ref },
        },
        defaultModel: { ...llm.defaultModel },
      })
    },

    async clearApiKey(id) {
      assertProviderId(id)
      const view = provider(id)
      const ref = view?.apiKeyEnv
      if (ref !== undefined) await options.credentials.unset(ref)

      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      if (current === undefined || current.apiKeyEnv === undefined) return
      const { apiKeyEnv: _apiKeyEnv, ...withoutRef } = current
      const nextProviders = { ...llm.providers }
      if (Object.keys(withoutRef).length === 0) delete nextProviders[id]
      else nextProviders[id] = withoutRef
      await persistLlm({
        providers: nextProviders,
        defaultModel: { ...llm.defaultModel },
      })
    },

    async probeModels(id, probeOptions = {}) {
      assertProviderId(id)
      return probeRouteModels(id, probeOptions)
    },

    async addModels(id, rows) {
      assertProviderId(id)
      if (provider(id) === undefined) throw new Error(`provider "${id}" is not configured`)
      return addModelRows(id, rows)
    },

    async setModel(id, modelId, fields) {
      assertProviderId(id)
      if (provider(id) === undefined) throw new Error(`provider "${id}" is not configured`)
      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      const models = current?.models ?? []
      const existing = models.find((model) => model.id === modelId)
      // The SETTINGS list, not the merged view: the view also carries template
      // rows, and a write has to land somewhere real.
      if (existing === undefined) {
        throw new Error(`provider "${id}" has no model "${modelId}"; add it first`)
      }
      const next: SettingsModel = { ...existing }
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue
        if (value === null) delete (next as unknown as Record<string, unknown>)[key]
        else (next as unknown as Record<string, unknown>)[key] = value
      }
      const merged = models.map((model) => (model.id === modelId ? next : { ...model }))
      await persistLlm({
        providers: { ...llm.providers, [id]: { ...(current ?? {}), models: merged } },
        defaultModel: { ...llm.defaultModel },
      })
      discovered.delete(id)
      return cloneModels(provider(id)?.models ?? merged)
    },

    async removeModel(id, modelId) {
      assertProviderId(id)
      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      if (current === undefined) throw new Error(`provider "${id}" is not configured`)
      const models = current.models ?? []
      if (!models.some((model) => model.id === modelId)) {
        throw new Error(`provider "${id}" has no model "${modelId}"`)
      }
      // `llm.defaultModel` is deliberately NOT touched: with D1's membership
      // check gone, a default naming a removed row still resolves.
      const merged = models.filter((model) => model.id !== modelId).map((model) => ({ ...model }))
      await persistLlm({
        providers: { ...llm.providers, [id]: { ...current, models: merged } },
        defaultModel: { ...llm.defaultModel },
      })
      discovered.delete(id)
      return cloneModels(provider(id)?.models ?? merged)
    },

    async discoverModels(id, discoveryOptions = {}) {
      assertProviderId(id)
      if (!discoveryOptions.force) {
        const cached = discovered.get(id)
        if (cached !== undefined) return cloneModels(cached)
      }
      // ONE merge implementation, two verbs: this is probe-then-add, and the
      // only thing it adds to that is the memo.
      const probed = await probeRouteModels(id, discoveryOptions)
      discoveryOptions.signal?.throwIfAborted()
      // An EMPTY result is legal, not an error: a gateway with no models listed
      // must not turn a working route into a failing command. Nothing to merge,
      // so nothing is written — but the memo is still filled, or the next
      // caller would re-probe for the same nothing.
      if (probed.length === 0) {
        const current = cloneModels(provider(id)?.models ?? [])
        discovered.set(id, cloneModels(current))
        return current
      }
      const merged = await addModelRows(id, probed)
      discovered.set(id, cloneModels(merged))
      return cloneModels(merged)
    },

    async setDefaultModel(selection) {
      const llm = canonicalLlm(options.settings)
      await persistLlm({
        providers: { ...llm.providers },
        defaultModel: { ...selection },
      })
    },

    async resolveModel(input) {
      const selection = selectModel(input, options.settings.get().llm.defaultModel)
      if ("state" in selection) return selection.state

      const { providerId, modelId } = selection
      const view = provider(providerId)
      if (view === undefined) {
        return invalidState(
          `Unknown provider "${providerId}"`,
          providerId,
          modelId,
        )
      }
      // NO MEMBERSHIP CHECK HERE, deliberately, and please do not add one back.
      //
      // There was one: `if (!view.models.some(m => m.id === modelId)) invalid`.
      // It broke on a VENDOR RENAME — `deepseek-flash` is the name DeepSeek's own
      // docs tell you to use, and our table still listed the retired
      // `deepseek-v4-flash` and friends, so the correct name was refused and the
      // obsolete ones were accepted. Measured 2026-09-19.
      //
      // It also bought nothing: every line below tolerates an undeclared model
      // (`userModel?.`, an optional `contextWindow` in the binding), and the one
      // thing a check could have supplied — the model's capacity — is not in the
      // table for this provider anyway (the entries are bare ids), so a DECLARED
      // model resolved no context window either. Six shipping harnesses were read
      // for this; four pass an unknown model through, one probes the provider,
      // and the two that refuse give an actionable message and a documented
      // escape hatch. This gave neither.
      //
      // The line that DOES belong is above: an unknown PROVIDER is still refused,
      // because without its entry there is no base URL and no credential source.
      // `view.models` remains the UI-facing directory — it is a list to choose
      // from, not a licence to run.

      const reasoningEffort = normalizeReasoningEffort(selection.reasoningEffort)
      if (selection.reasoningEffort !== undefined && reasoningEffort === undefined) {
        return invalidState(
          `Invalid reasoning effort "${selection.reasoningEffort}"`,
          providerId,
          modelId,
        )
      }

      const ref = authRef(view)
      if (ref === undefined) {
        return {
          status: "unconfigured",
          reason: `No API key configured for provider "${providerId}"`,
        }
      }

      let resolvedAuth: ResolvedProviderAuth | undefined
      try {
        resolvedAuth = await auth.resolve(ref, { providerId, purpose: "inference" })
      } catch (error) {
        return invalidState(
          `Failed to resolve authentication for provider "${providerId}": ${errorMessage(error)}`,
          providerId,
          modelId,
        )
      }
      if (resolvedAuth === undefined) {
        return {
          status: "unconfigured",
          reason: `No API key configured for provider "${providerId}"`,
        }
      }

      let apiKey: string | undefined
      if (resolvedAuth.kind === "ambient") {
        if (view.protocol !== "bedrock" || ref.kind !== "ambient") {
          return invalidState(
            `Ambient authentication is only supported for Bedrock provider "${providerId}"`,
            providerId,
            modelId,
          )
        }
      } else {
        apiKey = authValue(resolvedAuth)
        if (apiKey === undefined) {
          return {
            status: "unconfigured",
            reason: `No usable credential configured for provider "${providerId}"`,
          }
        }
      }

      const userModel = view.user?.models?.find((model) => model.id === modelId)
      // The chain, most specific first: the SELECTION (a session's or a role's),
      // then the model row, then the route — see runtimeProfile.
      const profile = runtimeProfile(
        view, apiKey, userModel?.inputModalities, selection.protocol ?? userModel?.protocol,
      )
      if (profile === undefined) {
        // The chain ran out. Name the ROUTE (not the model): the protocol is
        // the route's declaration, and `provider set` is the verb that owns it.
        return invalidState(
          `provider "${providerId}" declares no protocol, so "${modelId}" cannot be sent; set one with: i-harness provider set ${providerId} --protocol ${PROTOCOL_CHOICES}`,
          providerId,
          modelId,
        )
      }
      const contextWindow = resolveEffectiveModelContext({
        profile,
        modelId,
        ...(userModel !== undefined ? { userModel } : {}),
      })?.contextWindow

      try {
        const client = buildClient(profile, modelId)
        return {
          status: "ready",
          binding: {
            client,
            providerId,
            modelId,
            // M59 grok parity: the status row wears a HUMAN label —
            // "OpenCode Go · glm-5.3-flash" (provider displayName · model id);
            // the route-scoped `provider:model` string remains the fallback.
            label: view.displayName === "" || view.displayName === providerId
              ? `${providerId}:${modelId}`
              : `${view.displayName} · ${modelId}`,
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}),
          },
        }
      } catch (error) {
        return invalidState(
          `Failed to build model "${providerId}:${modelId}": ${errorMessage(error)}`,
          providerId,
          modelId,
        )
      }
    },
  }
}

function providerView(
  id: string,
  template: ProviderProfile | undefined,
  user: SettingsProviderConfig | undefined,
): ProviderView {
  // The chain ends in ABSENCE when nobody declared one — resolveProviderProtocol
  // has no tail to fall through to, and every reader below must handle the
  // absent case on its own terms.
  const protocol = user?.protocol ?? templateSettingsProtocol(template)
    ?? resolveProviderProtocol(id, user)
  const models = mergeModels(
    template?.models?.map((modelId) => ({ id: modelId })) ?? [],
    user?.models ?? [],
  )
  return {
    id,
    ...(template !== undefined ? { template } : {}),
    ...(user !== undefined ? { user } : {}),
    displayName: user?.displayName ?? template?.displayName ?? id,
    protocol,
    ...(user?.baseURL !== undefined
      ? { baseURL: user.baseURL }
      : template?.baseUrl !== undefined ? { baseURL: template.baseUrl } : {}),
    ...(user?.modelsURL !== undefined ? { modelsURL: user.modelsURL } : {}),
    ...(user?.catalog !== undefined ? { catalog: user.catalog } : {}),
    ...(user?.apiKeyEnv !== undefined
      ? { apiKeyEnv: user.apiKeyEnv }
      : template?.apiKeyEnv !== undefined ? { apiKeyEnv: template.apiKeyEnv } : {}),
    // M59: the user header MAP replaces the template's whole map when set
    // (not a per-key merge — a user map wins wholesale; the adapter/probe then
    // keeps its own auth keys on top).
    ...(user?.headers !== undefined
      ? { headers: user.headers }
      : template?.headers !== undefined ? { headers: template.headers } : {}),
    // M61: content types — a USER declaration wins over the built-in template
    // (absent on both = text-only, the M14 negative capability).
    ...(user?.inputModalities !== undefined
      ? { inputModalities: user.inputModalities }
      : template?.inputModalities !== undefined ? { inputModalities: template.inputModalities } : {}),
    models,
    ...(template?.defaultModel !== undefined ? { defaultModel: template.defaultModel } : {}),
  }
}

/** The card family a route resolves against: its DECLARED `catalog`, else its
 * own name. The single implementation of that rule — `runtimeProfile()` writes
 * it onto the profile the chain reads, and `directory()` reports it, so what a
 * listing SHOWS and what resolution USES are the same value. */
function cardFamilyOf(view: ProviderView): string {
  return view.catalog ?? view.id
}

function runtimeProfile(
  view: ProviderView,
  apiKey: string | undefined,
  modelModalities?: SettingsInputModality[],
  selectionProtocol?: SettingsProviderProtocol,
): ProviderProfile | undefined {
  // SELECTION-or-row, computed by the caller: a session's/role's selection
  // beats the model row, and both beat the route's default. NOBODY INVENTS
  // ONE — an absent protocol is the caller's refusal to write (protocol-
  // selection §2), because this is the one place that can tell "absent"
  // from "declared".
  const protocol = selectionProtocol ?? view.protocol
  if (protocol === undefined) return undefined
  const template = { ...(view.template ?? {}) }
  delete template.apiKey
  // M61: the MODEL entry narrows/overrides the route's declaration; absent on
  // both → no field (text-only, the M14 negative capability).
  const modalities = modelModalities ?? view.inputModalities
  return {
    ...template,
    name: view.id,
    // Declared family, else the route name. Set here so the resolution chain
    // never has to look at `name` for a purpose it was not given.
    catalog: cardFamilyOf(view),
    displayName: view.displayName,
    // The route is an endpoint, and an endpoint has one protocol — a
    // declaration that names another is naming a different endpoint path
    // under the same host and credential.
    protocol: adapterProtocol(protocol),
    ...(view.baseURL !== undefined ? { baseUrl: view.baseURL } : {}),
    ...(view.apiKeyEnv !== undefined ? { apiKeyEnv: view.apiKeyEnv } : {}),
    ...(view.headers !== undefined ? { headers: view.headers } : {}),
    ...(modalities !== undefined ? { inputModalities: modalities } : {}),
    models: view.models.map((model) => model.id),
    ...(apiKey !== undefined ? { apiKey } : {}),
  }
}

function authRef(view: ProviderView): ProviderAuthRef | undefined {
  if (view.apiKeyEnv !== undefined) return { kind: "api-key-ref", ref: view.apiKeyEnv }
  if (view.protocol === "bedrock") return { kind: "ambient" }
  return undefined
}

function authValue(auth: ResolvedProviderAuth | undefined): string | undefined {
  if (auth?.kind === "api-key") return auth.value.trim() === "" ? undefined : auth.value
  if (auth?.kind === "bearer") return auth.accessToken.trim() === "" ? undefined : auth.accessToken
  return undefined
}

function templateSettingsProtocol(
  template: ProviderProfile | undefined,
): SettingsProviderProtocol | undefined {
  if (template === undefined) return undefined
  return template.protocol === "openai-compatible" ? "openai-completions" : template.protocol
}

function adapterProtocol(protocol: SettingsProviderProtocol): ProviderProfile["protocol"] {
  return protocol === "openai-completions" ? "openai-compatible" : protocol
}

function selectModel(
  input: {
    sessionSelection?: { provider: string; model: string; protocol?: SettingsProviderProtocol; reasoningEffort?: string }
    override?: string
  },
  defaultModel: SettingsDefaultModel,
): SelectedModel | { state: ModelResolutionState } {
  if (input.override !== undefined && input.override !== "") {
    const separator = input.override.indexOf(":")
    if (separator <= 0 || separator === input.override.length - 1) {
      return {
        state: {
          status: "invalid",
          reason: `Invalid model override "${input.override}"; expected provider:model`,
        },
      }
    }
    return {
      providerId: input.override.slice(0, separator),
      modelId: input.override.slice(separator + 1),
    }
  }

  if (input.sessionSelection !== undefined) {
    if (input.sessionSelection.provider === "" || input.sessionSelection.model === "") {
      return { state: { status: "invalid", reason: "Session model selection requires provider and model" } }
    }
    return {
      providerId: input.sessionSelection.provider,
      modelId: input.sessionSelection.model,
      ...(input.sessionSelection.protocol !== undefined ? { protocol: input.sessionSelection.protocol } : {}),
      ...(input.sessionSelection.reasoningEffort !== undefined
        ? { reasoningEffort: input.sessionSelection.reasoningEffort }
        : {}),
    }
  }

  if (defaultModel.provider === "" || defaultModel.model === "") {
    return { state: { status: "unconfigured", reason: "No model configured" } }
  }
  return {
    providerId: defaultModel.provider,
    modelId: defaultModel.model,
    ...(defaultModel.reasoningEffort !== undefined
      ? { reasoningEffort: defaultModel.reasoningEffort }
      : {}),
  }
}

function invalidState(
  reason: string,
  providerId?: string,
  modelId?: string,
): ModelResolutionState {
  return {
    status: "invalid",
    reason,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
  }
}

function normalizeReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  return value !== undefined && REASONING_EFFORTS.has(value as ReasoningEffort)
    ? value as ReasoningEffort
    : undefined
}

function mergeModels(
  base: readonly ModelDescriptor[],
  overrides: readonly SettingsModel[],
): ModelDescriptor[] {
  const models = new Map<string, ModelDescriptor>()
  for (const model of base) models.set(model.id, { ...model })
  for (const model of overrides) {
    models.set(model.id, { ...models.get(model.id), ...model })
  }
  return [...models.values()]
}

function mergeDiscoveredModels(
  manual: readonly SettingsModel[],
  probe: readonly ModelDescriptor[],
): SettingsModel[] {
  const models = new Map<string, SettingsModel>()
  for (const model of manual) models.set(model.id, { ...model })
  for (const model of probe) {
    const existing = models.get(model.id)
    models.set(model.id, existing === undefined ? { ...model } : { ...model, ...existing })
  }
  return [...models.values()]
}

function cloneModels(models: readonly ModelDescriptor[]): ModelDescriptor[] {
  return models.map((model) => ({ ...model }))
}

function cloneProviderConfig(config: SettingsProviderConfig): SettingsProviderConfig {
  return {
    ...config,
    ...(config.models !== undefined ? { models: config.models.map((model) => ({ ...model })) } : {}),
  }
}

function canonicalLlm(settings: SettingsStoreSurface): SettingsLlm {
  const mutationBase = settings.getSectionMutationBase?.("llm")
  if (isSettingsLlm(mutationBase)) {
    return {
      providers: Object.fromEntries(
        Object.entries(mutationBase.providers).map(([id, config]) => [id, cloneProviderConfig(config)]),
      ),
      defaultModel: { ...mutationBase.defaultModel },
    }
  }
  const llm = settings.get().llm
  return {
    providers: Object.fromEntries(
      Object.entries(llm.providers).map(([id, config]) => [id, cloneProviderConfig(config)]),
    ),
    defaultModel: { ...llm.defaultModel },
  }
}

function isSettingsLlm(value: unknown): value is SettingsLlm {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.providers === "object" && record.providers !== null
    && !Array.isArray(record.providers)
    && typeof record.defaultModel === "object" && record.defaultModel !== null
    && !Array.isArray(record.defaultModel)
}

function providerApiKeyRef(id: string): string {
  let normalized = id.toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (normalized === "") normalized = "PROVIDER"
  if (/^[0-9]/.test(normalized)) normalized = `PROVIDER_${normalized}`
  return `${normalized}_API_KEY`
}

function assertProviderId(id: string): void {
  if (id.trim() === "") throw new Error("provider id is required")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
