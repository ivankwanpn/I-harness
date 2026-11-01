import type { PluginContext } from "../types.ts"
import type { InternalScope, ServiceStore } from "./types.ts"
import { createServices } from "./services.ts"
import { createListeners } from "./listeners.ts"
import { createWaterfalls } from "./waterfall.ts"
import { createCascades } from "./cascade.ts"
import { createPluginLifecycle } from "./dispose.ts"
import {associateExecutionHookScope} from '../execution-hooks.ts'

export function createScope(
  parentStore: ServiceStore | null,
  parentScope: InternalScope | null,
  parentEmit: (event: string, payload: unknown,current?:()=>void) => Promise<unknown>,
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
    on: (event,handler)=>listeners.register(event,handler),
    emit: (event,payload)=>listeners.emit(event,payload),
    waterfall: (event,handler)=>waterfall.register(event,handler),
    cascade: cascades.dispatch,
    onCascade: cascades.register,
    guard: listeners.guard,
    checkGuards: listeners.checkGuards,
    resolveDecision: listeners.resolveDecision,
    resolveAncestorDecision: listeners.resolveAncestorDecision,
    mount: lifecycle.mount,
    unmount: lifecycle.unmount,
  }

  associateExecutionHookScope(ctx,{parent:parentScope,surface(event){const plain=listeners.surface(event),chain=waterfall.surface(event);return {version:plain.version+':'+chain.version,compatible:plain.compatible&&chain.compatible}},on:(event,handler)=>listeners.register(event,handler,true),waterfall:(event,handler)=>waterfall.register(event,handler,true),emit:listeners.emit})
  return ctx
}
