import type { SettingsLlm } from "@i-harness/settings"

import type { CreateProviderRuntimeOptions } from "../types.ts"
import type { ProviderView } from "../directory/types.ts"
import { canonicalLlm } from "./store.ts"

import { assertProviderId, providerApiKeyRef } from "./validation.ts"
import type { ProviderRuntime } from "../types.ts"

export function createCredentialMutations(
  options: Pick<CreateProviderRuntimeOptions, "settings" | "credentials">,
  persistLlm: (next: SettingsLlm) => Promise<void>,
  provider: (id: string) => ProviderView | undefined,
): Pick<ProviderRuntime, "setApiKey" | "clearApiKey"> {
  return {
    async setApiKey(id, value) {
      assertProviderId(id)
      if (provider(id)?.user?.oauthAccountId) throw new Error("ChatGPT plan routes use account authorization, not API keys")
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
      if (provider(id)?.user?.oauthAccountId) throw new Error("Sign out of the ChatGPT account in Coding Plans")
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
    }
  }
}
