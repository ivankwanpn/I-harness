import type { PluginContext } from "../types.ts"
import type { ServiceStore } from "./types.ts"

/** One local store; the immediate parent's store remains a live reference. */
export function createServices(parentStore: ServiceStore | null): {
  store: ServiceStore
  services: PluginContext["services"]
} {
  const store: ServiceStore = new Map()
  const services: PluginContext["services"] = {
    register(name: string, impl: unknown): void {
      if (store.has(name)) throw new Error(`duplicate service registration: ${name}`)
      store.set(name, impl)
    },
    get<T>(name: string): T {
      if (store.has(name)) return store.get(name) as T
      if (parentStore?.has(name)) return parentStore.get(name) as T
      throw new Error(`service not found: ${name}`)
    },
  }
  return { store, services }
}
