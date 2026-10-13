import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderProfile, buildModelClient } from "@i-harness/provider"
import type { CreateProviderRuntimeOptions } from "../types.ts"
import type { ProviderView } from "../directory/types.ts"

/** One binding owns its active client and policies. Reads stay live per stream. */
export function createBindingClient(
  options: Pick<CreateProviderRuntimeOptions, "settings" | "readModelWait" | "readModelRetryLimit">,
  buildClient: typeof buildModelClient,
  profile: ProviderProfile,
  view: ProviderView,
  modelId: string,
): ModelClient {
  const initialWait = options.settings.get().modelWait
  profile.modelWait = { firstResponseMs: initialWait.firstResponseSeconds * 1000, progressMs: initialWait.progressSeconds * 1000 }
  let activeWait = initialWait
  let activeClient = buildClient(profile, modelId)
  let activeLimit = options.settings.get().modelRetryLimit
  const client: ModelClient = {
    async *stream(request) {
      request.signal?.throwIfAborted()
      const wait = options.readModelWait ? await options.readModelWait() : options.settings.get().modelWait
      const limit = view.template?.retryPolicy !== undefined ? activeLimit : options.readModelRetryLimit ? await options.readModelRetryLimit() : options.settings.get().modelRetryLimit
      request.signal?.throwIfAborted()
      if (limit !== activeLimit || wait.firstResponseSeconds !== activeWait.firstResponseSeconds || wait.progressSeconds !== activeWait.progressSeconds) {
        activeClient = buildClient({ ...profile, modelWait: { firstResponseMs: wait.firstResponseSeconds * 1000, progressMs: wait.progressSeconds * 1000 }, retryPolicy: view.template?.retryPolicy ?? { mode: "normal", maxRetries: limit } }, modelId)
        activeWait = wait
        activeLimit = limit
      }
      const current = activeClient
      yield* current.stream(request)
    },
  }

  return client
}
