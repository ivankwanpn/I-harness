// @i-harness/tui — M49 Task 6: the UI-only provider controller.
//
// The adapter OVER provider-runtime that the TUI surfaces drive: the typed
// provider draft (refs-not-values — the raw API key is written to the
// credential store, the settings document carries only apiKeyEnv), the
// selected-provider state the model picker/menu use, and the discovery state
// the master/detail flow renders (manual-only / failed with attempts,
// preserved stored models / ready). Persistence happens ONLY through the
// canonical settings llm.providers plane + credentials.
//
// Session-model selection is routed to the backend capability when a session
// is active (setSessionModel — idle-rebind semantics are the backend's);
// without one the selection persists to settings llm.defaultModel.

import type { ProviderRuntime, ProviderRuntimeEntry } from "@i-harness/provider-runtime"
import type { ModelDescriptor } from "@i-harness/provider"
import type {
  SettingsDefaultModel,
  SettingsModel,
  SettingsProviderConfig,
  SettingsProviderProtocol,
  SettingsStoreSurface,
} from "@i-harness/settings"
import type { SessionModelSelection } from "@i-harness/session-persistence"

/** Mask display for a credential: `x…` + the last 4 chars of the value;
 * "not set" when nothing is configured. NEVER shows the full key. */
export function maskKey(value: string | undefined): string {
  if (value === undefined || value === "") return "not set"
  const tail = value.length > 4 ? value.slice(-4) : value
  return `x…${tail}`
}

/** The provider save payload (settings-plane vocabulary: baseURL/modelsURL,
 * wire `protocol` kept canonical). `apiKey` is the CURRENT edit's raw key —
 * it goes to the credential store through the runtime; the settings document
 * carries only the ref. (The view's own editor draft is a separate type —
 * ProviderDraft in views/provider.ts.) */
export interface ProviderDraftInput {
  id: string
  displayName?: string
  protocol: SettingsProviderProtocol
  baseURL: string
  modelsURL?: string
  /** Raw key for the CURRENT edit (secret field — empty keeps the current
   * key on an existing provider). */
  apiKey?: string
}

export interface ProviderDiscoveryState {
  status: "idle" | "loading" | "ready" | "manual-only" | "failed"
  providerId?: string
  /** Manual-only: the literal runtime message. Failed: the candidate-attempt
   * summary (stored models are preserved — the runtime persists on success
   * only). Ready: the merged model count. */
  message?: string
  modelCount?: number
}

export interface ProviderControllerState {
  /** Directory snapshot (configured entries + real adapter templates). */
  providers: ProviderRuntimeEntry[]
  /** The provider the UI operations target (picker catalog etc.). */
  selectedProviderId: string | undefined
  /** The durable default model (settings llm.defaultModel). */
  defaultModel: SettingsDefaultModel
  /** The last discovery outcome (the master/detail views render this). */
  discovery: ProviderDiscoveryState
}

/** The backend seam the controller uses for session-model selection and the
 * startup model state (real hosts pass the BackendClient — the structural
 * subset keeps the controller unit-testable). */
export interface ProviderControllerBackend {
  setSessionModel?(selection: SessionModelSelection): Promise<unknown>
  modelState?(): Promise<unknown>
}

export interface ProviderControllerOptions {
  runtime: ProviderRuntime
  /** The durable settings store (llm.defaultModel reads + the UI snapshot). */
  settings: SettingsStoreSurface
  /** Live backend; with a sessionId the model selection goes through
   * setSessionModel (the active-session path). */
  backend?: ProviderControllerBackend
  /** The in-context session id (undefined = no active session). */
  sessionId?: string
}

export class ProviderController {
  private readonly runtimeInner: ProviderRuntime
  private readonly settings: SettingsStoreSurface
  private readonly backend: ProviderControllerBackend | undefined
  private readonly sessionId: string | undefined
  private readonly inner: ProviderControllerState

  constructor(options: ProviderControllerOptions) {
    this.runtimeInner = options.runtime
    this.settings = options.settings
    this.backend = options.backend
    this.sessionId = options.sessionId
    this.inner = {
      providers: [],
      selectedProviderId: undefined,
      defaultModel: { provider: "", model: "" },
      discovery: { status: "idle" },
    }
  }

  /** The state the views read (one stable object — the methods mutate it). */
  state(): ProviderControllerState {
    return this.inner
  }

  /** The wrapped runtime (the typed settings rows use the runtime seam). */
  providerRuntime(): ProviderRuntime {
    return this.runtimeInner
  }

  /** The settings surface (the durable write path the typed rows share). */
  settingsSurface(): SettingsStoreSurface {
    return this.settings
  }

  /** Clear the settings default (the picker's `(no override)` row). */
  async clearModelSelection(): Promise<void> {
    await this.runtimeInner.setDefaultModel({ provider: "", model: "" })
    this.inner.defaultModel = { provider: "", model: "" }
  }

  /** Refresh the directory snapshot and return it. */
  async directory(): Promise<ProviderRuntimeEntry[]> {
    const rows = await this.runtimeInner.directory()
    this.inner.providers = rows
    return rows
  }

  /** The durable default model (settings llm.defaultModel). */
  defaultModel(): SettingsDefaultModel {
    const dm = this.settings.get().llm.defaultModel
    this.inner.defaultModel = { ...dm }
    return this.inner.defaultModel
  }

  /**
   * Activate a provider as the selected one and run discovery, recording the
   * outcome in state.discovery (manual-only for bedrock, failed with the
   * attempt summary otherwise, ready on success). Discovery failure NEVER
   * drops stored models (the runtime persists only on success).
   */
  async selectProvider(id: string): Promise<void> {
    // The selection lands synchronously — a concurrent selection action
    // (e.g. the picker's Enter) never races the directory refresh.
    this.inner.selectedProviderId = id
    this.inner.discovery = { status: "loading", providerId: id }
    await this.directory()
    try {
      const models = await this.runtimeInner.discoverModels(id)
      this.inner.discovery = { status: "ready", providerId: id, modelCount: models.length }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith("Discovery is not available for this provider")) {
        this.inner.discovery = { status: "manual-only", providerId: id, message }
      } else {
        this.inner.discovery = { status: "failed", providerId: id, message }
      }
    }
  }

  /** Discovery-only run (the /provider reload path) — throws on failure (the
   * caller toasts); the selector's state stays untouched. */
  async discoverModels(id: string, force = false): Promise<number> {
    const models = await this.runtimeInner.discoverModels(id, { force })
    this.inner.discovery = { status: "ready", providerId: id, modelCount: models.length }
    return models.length
  }

  /** Add/update one provider (refs-not-values: `apiKey` goes to the credential
   * store through the runtime; the settings document carries the ref only).
   * The existing row's fields survive (models/displayName/modelsURL merge —
   * the editor's 3 fields never clobber the stored catalog). */
  async saveProvider(draft: ProviderDraftInput): Promise<void> {
    const id = draft.id.trim()
    if (id === "") throw new Error("provider id is required")
    if (draft.baseURL.trim() === "") throw new Error("base URL is required")
    const current = this.configOf(id)
    const config: SettingsProviderConfig = {
      baseURL: stripBaseURLSuffix(draft.baseURL.trim()),
      protocol: draft.protocol,
      ...(draft.displayName !== undefined && draft.displayName !== "" ? { displayName: draft.displayName } : {}),
      ...(draft.modelsURL !== undefined && draft.modelsURL !== "" ? { modelsURL: draft.modelsURL.trim() } : {}),
      // The editor's 3 fields never clobber the stored row: the ref (empty
      // key keeps the current key), display name, models URL and the stored
      // catalog merge through.
      ...(current?.apiKeyEnv !== undefined ? { apiKeyEnv: current.apiKeyEnv } : {}),
      ...(current?.displayName !== undefined && draft.displayName === undefined ? { displayName: current.displayName } : {}),
      ...(current?.modelsURL !== undefined && draft.modelsURL === undefined ? { modelsURL: current.modelsURL } : {}),
      ...(current?.models !== undefined ? { models: current.models.map((model) => ({ ...model })) } : {}),
    }
    await this.runtimeInner.upsertProvider(id, config)
    if (draft.apiKey !== undefined && draft.apiKey !== "") {
      await this.runtimeInner.setApiKey(id, draft.apiKey)
    }
    await this.directory()
  }

  /** The stored settings config for one provider (the editor's prefill) —
   * the settings plane is read-only here; no key material is exposed. */
  configOf(id: string): SettingsProviderConfig | undefined {
    const cfg = this.settings.get().llm.providers[id]
    return cfg === undefined ? undefined : { ...cfg }
  }

  /** The stored model catalog of one provider (settings plane — the model
   * picker/view rows; name + caps only, no key material). */
  modelsOf(id: string): ModelDescriptor[] {
    const cfg = this.settings.get().llm.providers[id]
    return (cfg?.models ?? []).map((model) => ({
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    }))
  }

  /** Add one manual model row to a provider's stored catalog (the discovery-
   * unavailable path; merges — never wipes discovered rows). */
  async addManualModel(providerId: string, model: SettingsModel): Promise<void> {
    const llm = this.settings.get().llm
    const config = llm.providers[providerId]
    if (config === undefined) throw new Error(`provider "${providerId}" is not configured`)
    if (model.id.trim() === "") throw new Error("model id is required")
    const models = new Map((config.models ?? []).map((m) => [m.id, { ...m }]))
    models.set(model.id, { ...model })
    await this.settings.set({
      llm: {
        providers: {
          ...llm.providers,
          [providerId]: { ...config, models: [...models.values()] },
        },
        defaultModel: { ...llm.defaultModel },
      },
    })
    await this.directory()
  }

  /** Remove one provider (the runtime clears the default-model pin too). */
  async removeProvider(id: string): Promise<void> {
    await this.runtimeInner.removeProvider(id)
    if (this.inner.selectedProviderId === id) this.inner.selectedProviderId = undefined
    await this.directory()
  }

  /**
   * Select a model from the SELECTED provider. With an active session the
   * selection goes through the backend capability (setSessionModel — idle
   * rebind is the backend's contract); otherwise it persists to
   * settings llm.defaultModel. `reasoningEffort` is optional (absent keeps
   * the current default's effort).
   */
  async selectModel(modelId: string, reasoningEffort?: string): Promise<void> {
    const providerId = this.inner.selectedProviderId
    if (providerId === undefined) throw new Error("no provider selected (select a provider first)")
    const current = this.defaultModel()
    const effort = reasoningEffort ?? current.reasoningEffort
    const selection: SessionModelSelection = {
      provider: providerId,
      model: modelId,
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
    }
    if (this.backend?.setSessionModel !== undefined && this.sessionId !== undefined) {
      await this.backend.setSessionModel(selection)
      return
    }
    await this.runtimeInner.setDefaultModel(selection)
    this.inner.defaultModel = { ...selection }
  }
}

/** The host root (no trailing /v1 — the adapters assemble it; the runtime's
 * canonical plane keeps the same stripping rule). */
function stripBaseURLSuffix(baseURL: string): string {
  return baseURL.replace(/(?:^|\/)v1\/?$/, "")
}
