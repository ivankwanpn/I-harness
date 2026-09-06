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
  resolveProviderProtocol,
  type SettingsDefaultModel,
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
  protocol: SettingsProviderProtocol
  configured: boolean
  auth: {
    configured: boolean
    source?: "env" | "file" | "ambient" | "oauth"
    writable: boolean
  }
  models: ModelDescriptor[]
  defaultModel?: string
  discovery: "available" | "manual-only"
}

export interface ProviderRuntime {
  directory(): Promise<ProviderRuntimeEntry[]>
  upsertProvider(id: string, config: SettingsProviderConfig): Promise<void>
  removeProvider(id: string): Promise<void>
  setApiKey(id: string, value: string): Promise<void>
  clearApiKey(id: string): Promise<void>
  discoverModels(
    id: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<ModelDescriptor[]>
  setDefaultModel(selection: SettingsDefaultModel): Promise<void>
  resolveModel(input: {
    sessionSelection?: { provider: string; model: string; reasoningEffort?: string }
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
  protocol: SettingsProviderProtocol
  baseURL?: string
  modelsURL?: string
  apiKeyEnv?: string
  models: ModelDescriptor[]
  defaultModel?: string
}

interface SelectedModel {
  providerId: string
  modelId: string
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

    async removeProvider(id) {
      assertProviderId(id)
      const llm = canonicalLlm(options.settings)
      if (llm.providers[id] === undefined) return
      const nextProviders = { ...llm.providers }
      delete nextProviders[id]
      const defaultModel = llm.defaultModel.provider === id
        ? { provider: "", model: "" }
        : { ...llm.defaultModel }
      await persistLlm({ providers: nextProviders, defaultModel })
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

    async discoverModels(id, discoveryOptions = {}) {
      assertProviderId(id)
      if (!discoveryOptions.force) {
        const cached = discovered.get(id)
        if (cached !== undefined) return cloneModels(cached)
      }
      discoveryOptions.signal?.throwIfAborted()

      const view = provider(id)
      if (view === undefined) throw new Error(`provider "${id}" is not configured`)
      if (view.protocol === "bedrock") {
        throw new Error("Discovery is not available for this provider; add a model ID manually.")
      }

      const ref = authRef(view)
      if (ref === undefined) throw new Error(`No API key configured for provider "${id}"`)
      const resolvedAuth = await auth.resolve(ref, {
        providerId: id,
        purpose: "discovery",
        ...(discoveryOptions.signal !== undefined ? { signal: discoveryOptions.signal } : {}),
      })
      const apiKey = authValue(resolvedAuth)
      if (apiKey === undefined) throw new Error(`No API key configured for provider "${id}"`)
      discoveryOptions.signal?.throwIfAborted()

      const models = await registry.probeModels(id, {
        ...(view.modelsURL !== undefined
          ? { modelsURL: view.modelsURL }
          : view.baseURL !== undefined ? { baseURL: view.baseURL } : {}),
        apiKey,
        protocol: view.protocol,
      })
      discoveryOptions.signal?.throwIfAborted()

      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      const mergedUserModels = mergeDiscoveredModels(current?.models ?? [], models)
      await persistLlm({
        providers: {
          ...llm.providers,
          [id]: { ...(current ?? {}), models: mergedUserModels },
        },
        defaultModel: { ...llm.defaultModel },
      })

      const mergedCatalog = provider(id)?.models ?? mergedUserModels
      discovered.set(id, cloneModels(mergedCatalog))
      return cloneModels(mergedCatalog)
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
      if (!view.models.some((model) => model.id === modelId)) {
        return invalidState(
          `Model "${providerId}:${modelId}" is not in the configured catalog`,
          providerId,
          modelId,
        )
      }

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

      const profile = runtimeProfile(view, apiKey)
      const userModel = view.user?.models?.find((model) => model.id === modelId)
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
            label: `${providerId}:${modelId}`,
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
    ...(user?.apiKeyEnv !== undefined
      ? { apiKeyEnv: user.apiKeyEnv }
      : template?.apiKeyEnv !== undefined ? { apiKeyEnv: template.apiKeyEnv } : {}),
    models,
    ...(template?.defaultModel !== undefined ? { defaultModel: template.defaultModel } : {}),
  }
}

function runtimeProfile(view: ProviderView, apiKey: string | undefined): ProviderProfile {
  const template = { ...(view.template ?? {}) }
  delete template.apiKey
  return {
    ...template,
    name: view.id,
    displayName: view.displayName,
    protocol: adapterProtocol(view.protocol),
    ...(view.baseURL !== undefined ? { baseUrl: view.baseURL } : {}),
    ...(view.apiKeyEnv !== undefined ? { apiKeyEnv: view.apiKeyEnv } : {}),
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
    sessionSelection?: { provider: string; model: string; reasoningEffort?: string }
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
