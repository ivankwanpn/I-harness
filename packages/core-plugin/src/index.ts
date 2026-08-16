export type NextFn = (payload: unknown) => unknown | Promise<unknown>
export type Listener = (payload: unknown, next: NextFn) => unknown | Promise<unknown>
export type WaterfallHandler = Listener
export type GuardFn = (exec: unknown) => string | undefined

export interface Plugin {
  name: string
  mount(ctx: PluginContext): void
  unmount?(ctx: PluginContext): void
}

export interface PluginContext {
  services: {
    register(name: string, impl: unknown): void
    get<T>(name: string): T
  }
  scope: {
    mount(): PluginContext
    unmount(): void
  }
  on(event: string, handler: WaterfallHandler): void
  emit(event: string, payload: unknown): Promise<void>
  waterfall(event: string, handler: WaterfallHandler): void
  guard(event: string, fn: GuardFn): void
  checkGuards(event: string, exec: unknown): string | undefined
  mount(plugin: Plugin): void
  unmount(name: string): void
}

type ServiceStore = Map<string, unknown>

interface OwnedListener {
  event: string
  handler: WaterfallHandler
}

function createScope(
  parentStore: ServiceStore | null,
  parentEmit: (event: string, payload: unknown) => Promise<void>,
): PluginContext {
  const store: ServiceStore = new Map()
  const listeners = new Map<string, WaterfallHandler[]>()
  const guards = new Map<string, GuardFn[]>()
  const scopes = new Set<PluginContext>()
  const plugins = new Map<string, Plugin>()
  const pluginListeners = new Map<string, OwnedListener[]>()
  const nestedPlugins = new Map<string, string[]>()
  let mountingPlugin: string | null = null

  function registerHandler(event: string, handler: WaterfallHandler): void {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
    if (mountingPlugin !== null) {
      const owned = pluginListeners.get(mountingPlugin) ?? []
      owned.push({ event, handler })
      pluginListeners.set(mountingPlugin, owned)
    }
  }

  // Waterfall dispatch: handlers run in registration order, each receiving a
  // `next` release function. A handler that declares a `next` parameter but
  // forgets to call it is treated as an ERROR (audit F02-1) — never a silent
  // veto. Handlers without a `next` parameter are plain listeners run in the
  // chain as pass-throughs. The handler list is re-snapshotted per dispatch so
  // registrations made mid-dispatch do not affect the current run.
  async function runNext(
    event: string,
    handlers: WaterfallHandler[],
    i: number,
    p: unknown,
  ): Promise<unknown> {
    if (i >= handlers.length) return p
    const handler = handlers[i]!
    if (handler.length < 2) {
      // Plain listener: no `next` parameter declared — pass through to the
      // following handler after it runs.
      const res = handler(p, () => undefined)
      if (isPromiseLike(res)) await res
      return runNext(event, handlers, i + 1, p)
    }
    let nextCalled = false
    const localNext = (pp: unknown): unknown | Promise<unknown> => {
      nextCalled = true
      return runNext(event, handlers, i + 1, pp)
    }
    const res = handler(p, localNext)
    const resolved = isPromiseLike(res) ? await res : res
    if (!nextCalled) {
      throw new Error(`waterfall handler ${i} for '${event}' forgot next()`)
    }
    return resolved ?? p
  }

  async function emitFn(event: string, payload: unknown): Promise<void> {
    const handlers = [...(listeners.get(event) ?? [])]
    if (handlers.length > 0) await runNext(event, handlers, 0, payload)
    await parentEmit(event, payload)
  }

  const ctx: PluginContext = {
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
      mount(): PluginContext {
        const child = createScope(store, emitFn)
        scopes.add(child)
        return child
      },
      unmount(): void {
        scopes.delete(ctx)
      },
    },
    on(event: string, handler: WaterfallHandler): void {
      registerHandler(event, handler)
    },
    emit: emitFn,
    waterfall(event: string, handler: WaterfallHandler): void {
      registerHandler(event, handler)
    },
    guard(event: string, fn: GuardFn): void {
      const list = guards.get(event) ?? []
      list.push(fn)
      guards.set(event, list)
    },
    checkGuards(event: string, exec: unknown): string | undefined {
      for (const fn of guards.get(event) ?? []) {
        const reason = fn(exec)
        if (reason !== undefined) return reason // first deny wins; later guards cannot re-allow
      }
      return undefined
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
    plugins.delete(name) // remove before recursing so same-name/cycle chains terminate
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
  }

  return ctx
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  )
}

export function createContext(): PluginContext {
  return createScope(null, async () => {})
}

export const corePluginVersion = "0.1.0"
