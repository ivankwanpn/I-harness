import { buildModelClient, defaultProviderRegistry } from "@i-harness/provider"
import type { CreateProviderRuntimeOptions, ProviderRuntime } from "../types.ts"
import { createRuntimeAuth } from "./auth.ts"
import { createDirectory } from "../directory/view.ts"
import { createLlmPersistence } from "../configuration/store.ts"
import { createRouteMutations } from "../configuration/routes.ts"
import { createModelMutations } from "../configuration/models.ts"
import { createCredentialMutations } from "../configuration/credentials.ts"
import { createDiscovery } from "./discovery.ts"
import { createMediaRuntime } from "./media.ts"
import { createModelResolver } from "../selection/resolve.ts"

/** Assemble narrow owners around the same live store, registry and auth resolver. */
export function createProviderRuntime(options: CreateProviderRuntimeOptions): ProviderRuntime {
  const registry = options.registry ?? defaultProviderRegistry()
  const auth = createRuntimeAuth(options)
  const buildClient = options.buildClient ?? buildModelClient
  const views = createDirectory(options.settings, registry, auth)
  const persistLlm = createLlmPersistence(options.settings)
  const discovery = createDiscovery(options, registry, auth, views.provider)
  const routes = createRouteMutations(options, persistLlm, discovery.invalidateDiscovery)
  const { addModelRows, ...models } = createModelMutations(options, persistLlm, discovery.invalidateDiscovery, views.provider)
  const credentials = createCredentialMutations(options, persistLlm, views.provider)
  const media = createMediaRuntime(options, auth, views.provider)
  const selection = createModelResolver(options, auth, buildClient, views.provider)
  return {
    replaceSubscriptionModels: models.replaceSubscriptionModels,
    directory: views.directory,
    upsertProvider: routes.upsertProvider,
    createProvider: routes.createProvider,
    patchProvider: routes.patchProvider,
    removeProvider: routes.removeProvider,
    setApiKey: credentials.setApiKey,
    clearApiKey: credentials.clearApiKey,
    probeModels: discovery.probeModels,
    addModels: models.addModels,
    setModel: models.setModel,
    removeModel: models.removeModel,
    discoverModels: (id, discoveryOptions = {}) => discovery.discoverModels(id, discoveryOptions, addModelRows),
    setDefaultModel: routes.setDefaultModel,
    setVideoAudioModel: media.setVideoAudioModel,
    analyzeVideoAudio: media.analyzeVideoAudio,
    resolveModel: selection.resolveModel,
    describeModelBindingMetadata: selection.describeModelBindingMetadata,
  }
}
