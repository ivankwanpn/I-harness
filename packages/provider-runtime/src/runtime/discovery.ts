import type { ProviderRegistry, ModelDescriptor } from "@i-harness/provider"
import type { SettingsProviderProtocol, SettingsModel } from "@i-harness/settings"
import type { ProviderAuthResolver } from "@i-harness/credentials"
import type { CreateProviderRuntimeOptions, ProviderRuntime } from "../types.ts"
import type { ProviderView } from "../directory/types.ts"
import { cloneModels } from "../directory/merge.ts"
import { authRef, authValue } from "./auth.ts"
import { assertProviderId, validateChatGptRoute } from "../configuration/validation.ts"
import { PROTOCOL_CHOICES } from "../selection/choice.ts"

/** The sole owner of the runtime's discovery memo; mutations invalidate it. */
export function createDiscovery(
  options: Pick<CreateProviderRuntimeOptions, "codex">,
  registry: ProviderRegistry,
  auth: ProviderAuthResolver,
  provider: (id: string) => ProviderView | undefined,
) {
  const discovered = new Map<string, ModelDescriptor[]>()
  /** One probe, one credential resolution, no writes. The single implementation
     * behind `probeModels` and `discoverModels`. */
  async function probeRouteModels(
    id: string,
    probeOptions: { signal?: AbortSignal; protocol?: SettingsProviderProtocol },
  ): Promise<ModelDescriptor[]> {
    probeOptions.signal?.throwIfAborted()

    const view = provider(id)
    if (view === undefined) throw new Error(`provider "${id}" is not configured`)
    if (view.user?.oauthAccountId) {
      validateChatGptRoute(view.user, probeOptions.protocol)
      if (!options.codex) throw new Error("Codex account service unavailable")
      const models = await options.codex.models(view.user.oauthAccountId)
      probeOptions.signal?.throwIfAborted()
      return models
    }
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
      ...(probeOptions.signal !== undefined ? { signal: probeOptions.signal } : {}),
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
    probeOptions.signal?.throwIfAborted()
    // Copied: the registry's array is not a caller's to mutate.
    return cloneModels(models)
  }
  const probes: Pick<ProviderRuntime, "probeModels"> = {
    async probeModels(id, probeOptions = {}) {
      assertProviderId(id)
      return probeRouteModels(id, probeOptions)
    }
  }
  async function discoverModels(
    id: string,
    discoveryOptions: { force?: boolean; signal?: AbortSignal } = {},
    addModelRows: (id: string, rows: readonly SettingsModel[]) => Promise<ModelDescriptor[]>,
  ) {
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
  }
  return { probeModels: probes.probeModels, discoverModels, invalidateDiscovery: (id: string) => { discovered.delete(id) } }
}
