import type { SettingsLlm, SettingsModel } from "@i-harness/settings"
import type { ModelDescriptor } from "@i-harness/provider"
import type { CreateProviderRuntimeOptions } from "../types.ts"
import type { ProviderView } from "../directory/types.ts"
import { canonicalLlm } from "./store.ts"
import { cloneModels, mergeDiscoveredModels } from "../directory/merge.ts"
import { assertProviderId, validateChatGptRoute } from "./validation.ts"
import type { ProviderRuntime } from "../types.ts"

export function createModelMutations(
  options: Pick<CreateProviderRuntimeOptions, "settings">,
  persistLlm: (next: SettingsLlm) => Promise<void>,
  invalidateDiscovery: (id: string) => void,
  provider: (id: string) => ProviderView | undefined,
): Pick<ProviderRuntime, "replaceSubscriptionModels" | "addModels" | "setModel" | "removeModel"> & { addModelRows: (id: string, rows: readonly SettingsModel[]) => Promise<ModelDescriptor[]> } {
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
    if (current?.oauthAccountId) validateChatGptRoute({ ...current, models: additions })
    const models = mergeDiscoveredModels(current?.models ?? [], additions)
    await persistLlm({
      providers: { ...llm.providers, [id]: { ...(current ?? {}), models } },
      defaultModel: { ...llm.defaultModel },
    })
    invalidateDiscovery(id)
    return cloneModels(provider(id)?.models ?? models)
  }
  return {
    addModelRows,
    async replaceSubscriptionModels(id, accountId, rows) {
      const llm = canonicalLlm(options.settings)
      const current = llm.providers[id]
      if (!current || current.oauthAccountId !== accountId || current.oauthProvider !== "openai-codex") throw new Error("Subscription account route did not match")
      validateChatGptRoute(current)
      if (rows.some(row => typeof row.id !== "string" || !row.id.trim())) throw new Error("Invalid subscription model catalog")
      await persistLlm({ ...llm, providers: { ...llm.providers, [id]: { ...current, models: rows.map(row => ({ ...row })) } } })
      invalidateDiscovery(id)
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
      if (current?.oauthAccountId) validateChatGptRoute({ ...current, models: merged })
      await persistLlm({
        providers: { ...llm.providers, [id]: { ...(current ?? {}), models: merged } },
        defaultModel: { ...llm.defaultModel },
      })
      invalidateDiscovery(id)
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
      invalidateDiscovery(id)
      return cloneModels(provider(id)?.models ?? merged)
    }
  }
}
