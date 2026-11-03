import type { ProviderRegistry } from "@i-harness/provider"
import type { SettingsStoreSurface } from "@i-harness/settings"
import type { ProviderAuthResolver } from "@i-harness/credentials"
import type { ProviderView } from "./types.ts"
import type { ProviderRuntimeEntry } from "../types.ts"
import { providerView, cardFamilyOf } from "./profile.ts"
import { cloneModels } from "./merge.ts"
import { canonicalLlm } from "../configuration/store.ts"
import { authRef } from "../runtime/auth.ts"

/** Read views are rebuilt from the current store and registry on every call. */
export function createDirectory(settings: SettingsStoreSurface, registry: ProviderRegistry, auth: ProviderAuthResolver) {
  function providers(): Map<string, ProviderView> {
    const userProviders = settings.get().llm.providers
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
    const user = settings.get().llm.providers[id]
    const template = registry.get(id)
    if (user === undefined && template === undefined) return undefined
    return providerView(id, template, user)
  }
  return {
    providers, provider, async directory() {
      const rows: ProviderRuntimeEntry[] = []
      const selectedDefault = canonicalLlm(settings).defaultModel
      for (const view of providers().values()) {
        const ref = authRef(view)
        const authInfo = ref === undefined
          ? { configured: false, writable: true }
          : await auth.describe(ref)
        rows.push({
          id: view.id,
          displayName: view.displayName,
          ...(view.user?.oauthAccountId ? { oauthAccountId: view.user.oauthAccountId } : {}),
          ...(view.user?.oauthProvider ? { oauthProvider: view.user.oauthProvider } : {}),
          ...(view.baseURL !== undefined ? { baseURL: view.baseURL } : {}),
          ...(view.modelsURL !== undefined ? { modelsURL: view.modelsURL } : {}),
          ...(view.apiKeyEnv !== undefined ? { apiKeyEnv: view.apiKeyEnv } : {}),
          protocol: view.protocol,
          configured: view.user !== undefined,
          auth: { ...authInfo },
          // Older route declarations are projected onto each listed model so
          // the directory and model binding describe the same capability.
          models: cloneModels(view.models).map((model) => {
            const modalities = model.inputModalities ?? view.inputModalities
            return { ...model, ...(modalities ? { inputModalities: [...modalities] } : {}), ...(view.user?.oauthProvider === "openai-codex" ? { protocol: "openai-responses" as const } : {}) }
          }),
          ...(view.defaultModel !== undefined ? { defaultModel: view.defaultModel } : {}),
          ...(settings.get().llm.videoAudio?.provider === view.id ? { videoAudioModel: settings.get().llm.videoAudio!.model } : {}),
          ...(selectedDefault.provider === view.id && selectedDefault.model ? { selectedDefaultModel: selectedDefault.model } : {}),
          discovery: view.protocol === "bedrock" ? "manual-only" : "available",
          cardFamily: cardFamilyOf(view),
          ...(view.catalog !== undefined ? { catalog: view.catalog } : {}),
          ...(view.promptCache !== undefined ? { promptCache: { ...view.promptCache } } : {}),
        })
      }
      return rows
    }
  }
}
