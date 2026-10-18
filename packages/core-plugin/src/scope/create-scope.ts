import type { PluginContext } from "../types.ts"
import type { InternalScope, ServiceStore } from "./types.ts"
import { createServices } from "./services.ts"
import { createListeners } from "./listeners.ts"
import { createWaterfalls } from "./waterfall.ts"
import { createCascades } from "./cascade.ts"
import { createPluginLifecycle } from "./dispose.ts"

export function createScope(
  parentStore: ServiceStore | null,
  parentScope: InternalScope | null,
  parentEmit: (event: string, payload: unknown) => Promise<unknown>,
): PluginContext {
  const { store, services } = createServices(parentStore)
  const scopes = new Set<PluginContext>()
  // Accessors are consumed only after ctx/lifecycle initialization, retaining
  // the live mounting stack and scope references across nested calls.
  const getMountingPlugin = () => lifecycle.mountingPlugin()
  const getScope = () => ctx
  const waterfall = createWaterfalls(getMountingPlugin)
  const listeners = createListeners(getMountingPlugin, getScope, parentEmit, waterfall)
  const cascades = createCascades(getMountingPlugin, getScope)
  const lifecycle = createPluginLifecycle(getScope, (name) => {
    listeners.reclaim(name)
    waterfall.reclaim(name)
    cascades.reclaim(name)
  })

  const ctx: PluginContext & InternalScope = {
    parentScope,
    checkLocalGuards: listeners.checkLocalGuards,
    resolveLocalDecision: listeners.resolveLocalDecision,
    localCascades: cascades.localCascades,
    services,
    scope: {
      mount(): PluginContext {
        const child = createScope(store, ctx, listeners.emit)
        scopes.add(child)
        return child
      },
      unmount(): void {
        // Preserve the existing local-Set behavior; I4/E2 owns its repair.
        scopes.delete(ctx)
      },
    },
    on: listeners.register,
    emit: listeners.emit,
    waterfall: waterfall.register,
    cascade: cascades.dispatch,
    onCascade: cascades.register,
    guard: listeners.guard,
    checkGuards: listeners.checkGuards,
    resolveDecision: listeners.resolveDecision,
    resolveAncestorDecision: listeners.resolveAncestorDecision,
    mount: lifecycle.mount,
    unmount: lifecycle.unmount,
  }

  return ctx
}
