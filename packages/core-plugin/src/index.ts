interface Plugin {
  name: string
  mount(ctx: PluginContext): void
  unmount?(ctx: PluginContext): void
}

interface Scope {
  services: {
    register(name: string, impl: unknown): void
    get<T>(name: string): T
  }
  scope: {
    mount(): Scope
    unmount(): void
  }
  on(event: string, handler: (payload: unknown) => unknown): void
  emit(event: string, payload: unknown): void
  mount(plugin: Plugin): void
  unmount(name: string): void
}

type ServiceStore = Map<string, unknown>

interface OwnedListener {
  event: string
  handler: (payload: unknown) => unknown
}

function createScope(parentStore: ServiceStore | null, parentEmit: (event: string, payload: unknown) => void): Scope {
  const store: ServiceStore = new Map()
  const listeners = new Map<string, Array<(payload: unknown) => unknown>>()
  const scopes = new Set<Scope>()
  const plugins = new Map<string, Plugin>()
  const pluginListeners = new Map<string, OwnedListener[]>()
  const nestedPlugins = new Map<string, string[]>()
  let mountingPlugin: string | null = null

  function emitHere(event: string, payload: unknown): void {
    for (const handler of listeners.get(event) ?? []) handler(payload)
    parentEmit(event, payload)
  }

  const ctx: Scope = {
    services: {
      register(name: string, impl: unknown): void {
        if (store.has(name)) throw new Error(`duplicate service registration: ${name}`)
        store.set(name, impl)
      },
      get<T>(name: string): T {
        if (store.has(name)) return store.get(name) as T
        if (parentStore?.has(name)) return parentStore.get(name) as T
        throw new Error(`service not found: ${name}`)
      },
    },
    scope: {
      mount(): Scope {
        const child = createScope(store, emitHere)
        scopes.add(child)
        return child
      },
      unmount(): void {
        scopes.delete(ctx)
      },
    },
    on(event: string, handler: (payload: unknown) => unknown): void {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      if (mountingPlugin !== null) {
        const owned = pluginListeners.get(mountingPlugin) ?? []
        owned.push({ event, handler })
        pluginListeners.set(mountingPlugin, owned)
      }
    },
    emit(event: string, payload: unknown): void {
      emitHere(event, payload)
    },
    mount(plugin: Plugin): void {
      plugins.set(plugin.name, plugin)
      if (mountingPlugin !== null) {
        const nested = nestedPlugins.get(mountingPlugin) ?? []
        nested.push(plugin.name)
        nestedPlugins.set(mountingPlugin, nested)
      }
      const prev = mountingPlugin
      mountingPlugin = plugin.name
      try {
        plugin.mount(ctx)
      } finally {
        mountingPlugin = prev
      }
    },
    unmount(name: string): void {
      reclaim(name)
    },
  }

  function reclaim(name: string): void {
    const plugin = plugins.get(name)
    if (!plugin) return
    plugin.unmount?.(ctx)
    for (const child of nestedPlugins.get(name) ?? []) reclaim(child)
    for (const { event, handler } of pluginListeners.get(name) ?? []) {
      const list = listeners.get(event)
      if (list) {
        const index = list.indexOf(handler)
        if (index !== -1) list.splice(index, 1)
      }
    }
    pluginListeners.delete(name)
    nestedPlugins.delete(name)
    plugins.delete(name)
  }

  return ctx
}

export function createContext(): Scope {
  return createScope(null, () => {})
}

export type PluginContext = Scope
export type { Plugin }
export const corePluginVersion = "0.1.0"
