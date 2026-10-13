import type { SettingsLlm, SettingsProviderConfig } from "@i-harness/settings"

import type { CreateProviderRuntimeOptions } from "../types.ts"

import { canonicalLlm } from "./store.ts"
import { cloneProviderConfig } from "../directory/merge.ts"
import { assertProviderId, validateChatGptRoute, PATCHABLE_PROVIDER_FIELDS } from "./validation.ts"
import { validatePromptCacheConfig } from "@i-harness/llm-seam"
import type { ProviderRuntime } from "../types.ts"

export function createRouteMutations(
  options: Pick<CreateProviderRuntimeOptions, "settings">,
  persistLlm: (next: SettingsLlm) => Promise<void>,
  invalidateDiscovery: (id: string) => void,
): Pick<ProviderRuntime, "upsertProvider" | "createProvider" | "patchProvider" | "removeProvider" | "setDefaultModel"> {
  return {
    async upsertProvider(id, config) {
      assertProviderId(id)
      validateChatGptRoute(config)
      validatePromptCacheConfig(config.promptCache)
      const llm = canonicalLlm(options.settings)
      await persistLlm({
        providers: { ...llm.providers, [id]: cloneProviderConfig(config) },
        defaultModel: { ...llm.defaultModel },
      })
      invalidateDiscovery(id)
    },

    async createProvider(id, fields) {
      assertProviderId(id)
      validateChatGptRoute(fields)
      validatePromptCacheConfig(fields.promptCache)
      if (Object.hasOwn(fields, "inputModalities")) throw new Error("Input modality belongs to a model")
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
      invalidateDiscovery(id)
    },

    async patchProvider(id, patch) {
      assertProviderId(id)
      if (patch.promptCache !== null) validatePromptCacheConfig(patch.promptCache)
      if (Object.hasOwn(patch, "inputModalities")) throw new Error("Input modality belongs to a model")
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
      validateChatGptRoute(next)
      // No baseURL suffix-stripping here: `SettingsStore.set` normalizes every
      // write (normalizeSettings → normalizeProviderConfig → stripBaseURLSuffix),
      // so a second implementation in the runtime would be a second place for
      // the rule to live — and the helper is module-private in settings, so
      // reaching it would mean exporting it for one caller.
      await persistLlm({
        providers: { ...llm.providers, [id]: cloneProviderConfig(next) },
        defaultModel: { ...llm.defaultModel },
      })
      invalidateDiscovery(id)
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
        invalidateDiscovery(id)
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
      invalidateDiscovery(id)
    },

    async setDefaultModel(selection) {
      const llm = canonicalLlm(options.settings)
      await persistLlm({
        providers: { ...llm.providers },
        defaultModel: { ...selection },
      })
    }
  }
}
